"""MLX90640 열화상 콧구멍 호흡 어댑터.

legacy/tieng_rppg/confidence/thermal_mlx90640.py 의 캡처 계층과 respiration.py 의
ThermalNostrilSource 경로를 이식했다. 날숨(따뜻)·들숨(차가움)이 콧구멍 앞에 만드는
온도 진동을 호흡 신호로 쓴다.

카메라는 rppg.py 와 같은 이유로 전용 스레드에서 자기 속도로 돈다. read() 가 1Hz 로
불리는 것과 무관하게 20초 창이 채워져야 하기 때문이다. 온도 그리드는 ROI 평균 하나로
줄인 뒤 즉시 버린다 — 원본 프레임을 저장하지 않는 것은 가시광과 같은 규칙이다.

mock/live 를 파일로 나누지 않고 mode 로 가른다
--------------------------------------------
이 저장소의 다른 짝(hr_mock.py / rppg.py, env_mock.py / env_bme680.py)은 파일이
둘이다. 여기서는 하나로 둔다. 합성 카메라를 두는 목적이 "신호처리 경로가 맞게
도는가" 를 하드웨어 없이 보는 것인데, 파일을 나누면 mock 이 ROI 추출과 호흡 추정을
안 타게 되어 그 목적이 사라진다. 바뀌는 것은 프레임을 어디서 얻는지 한 군데뿐이다.

  mode: live       → MLX90640. 없으면 start() 가 예외를 내고 카드가 no_adapter 로 뜬다
  mode: simulated  → SyntheticThermalCamera

조용히 합성으로 갈아타지 않는다. config 가 live 인데 합성값을 내보내면 화면 뱃지가
"실측" 으로 뜨고, 그건 없는 값을 지어내는 것과 같다 (README §0-4).

MLX90640 특이사항
-----------------
* 정식 해상도 32x24 = 768 픽셀. 코 하나가 몇 픽셀 안 남으므로 ROI 가 MIN_ROI_PIXELS
  를 못 채우면 게이트가 막는다. 실장비 입고 후 "거리 vs ROI 픽셀수" 를 실측해
  MIN_ROI_PIXELS / MIN_DELTA_T 를 다시 잡을 것.
* Lepton 계열과 달리 플랫필드 보정(FFC) 셔터가 없다. 그래서 셔터 중 계단 오프셋을
  호흡으로 오인하는 문제가 이 센서에는 없고, 그 게이트도 두지 않았다.
* refresh 는 2~8Hz 를 쓴다. 더 높이면 프레임당 잡음이 커지고, 호흡 대역(0.1~0.5Hz)
  에는 4Hz 로도 나이퀴스트 여유가 충분하다.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np
import structlog

from api.schemas import Metric, Mode, State, server_now
from core import quality, thresholds
from core.adapters.base import SensorAdapter

log = structlog.get_logger(__name__)

FRAME_W = 32
FRAME_H = 24
FRAME_N = FRAME_W * FRAME_H

WINDOW_SEC = 40.0  # 보관 창. 분석에 쓰는 20초보다 길게 둬야 프레임이 빠져도 버틴다
MIN_SEC = quality.BAND_RR.min_window_sec  # 20초. 이보다 짧으면 추정하지 않는다
MIN_SAMPLES = 40  # 4Hz 로 20초면 80개다. 절반까지 빠져도 통과시킨다
RESAMPLE_FS = 4.0  # 호흡 상한 0.5Hz 의 8배. 프레임 간격이 불균일하므로 다시 샘플링
MIN_RESAMPLED = 32  # 이보다 적으면 스펙트럼이 의미 없다

# ※ 실장비가 없어 잠정값이다. 카메라를 붙이면 재측정할 것.
MIN_ROI_PIXELS = 4  # 이보다 적으면 코가 너무 멀다
MIN_DELTA_T = 0.5  # °C. MLX90640 의 NETD(~0.1°C) 를 여러 배 웃도는 선
DEFAULT_NOSTRIL_ROI = (13, 9, 6, 5)  # 32x24 프레임 좌표계 (x, y, w, h)


class ThermalRespiration(SensorAdapter):
    provides = ["rr"]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        nostril_roi: tuple[int, int, int, int] | list[int] = DEFAULT_NOSTRIL_ROI,
        refresh_hz: float = 4.0,
        window_s: float = WINDOW_SEC,
        synthetic_rpm: float = 15.0,
        thresholds_path: str = str(thresholds.DEFAULT_PATH),
    ) -> None:
        super().__init__(id, mode)
        # ROI 좌표는 config 에서 온다. RGB 얼굴 박스에서 오프셋으로 계산하는 편이
        # 정확하지만, 그러려면 이 어댑터가 rppg 어댑터를 알아야 해서 "어댑터는 자기
        # 자신 외에는 모른다"가 깨진다 (README §0-2). 정합은 실장비 입고 후 별도로.
        box = [int(v) for v in nostril_roi]
        if len(box) != 4:
            raise ValueError(f"nostril_roi 는 (x, y, w, h) 4개여야 한다: {nostril_roi!r}")
        self.nostril_roi = (box[0], box[1], box[2], box[3])
        self.refresh_hz = refresh_hz
        self.window_s = window_s
        self.synthetic_rpm = synthetic_rpm
        self.thresholds_path = Path(thresholds_path)

        self._camera: Any = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        # 아래는 전부 _lock 으로 보호한다. 캡처 스레드가 쓰고 read() 가 읽는다.
        self._times: deque[float] = deque()
        self._temps: deque[float] = deque()
        self._roi_pixels = 0
        self._delta_t = 0.0
        self._fault: str | None = None

        self._gate = 0.4
        # 시간적 일관성 성분용. 직전 추정과 그 시각을 들고 있다가 넘긴다.
        self._prev_bpm: float | None = None
        self._prev_t: float | None = None

    # --- 수명주기 --------------------------------------------------------- #

    async def start(self) -> None:
        self._gate = thresholds.load(self.thresholds_path).confidence_min
        loop = asyncio.get_running_loop()
        self._camera = await loop.run_in_executor(None, self._open_camera)

        self._stop.clear()
        self._thread = threading.Thread(
            target=self._capture_loop, name=f"thermal-{self.id}", daemon=True
        )
        self._thread.start()
        log.info(
            "thermal.started", adapter=self.id, mode=self.mode,
            gate=self._gate, roi=self.nostril_roi, refresh_hz=self.refresh_hz,
        )

    async def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None
        self._camera = None

    async def read(self) -> list[Metric]:
        with self._lock:
            if self._fault is not None:
                raise RuntimeError(self._fault)  # registry 가 state=error 로 강등한다
            times = np.asarray(self._times, dtype=np.float64)
            temps = np.asarray(self._temps, dtype=np.float64)
            roi_pixels = self._roi_pixels
            delta_t = self._delta_t

        loop = asyncio.get_running_loop()
        metric = await loop.run_in_executor(
            None, self._estimate, times, temps, roi_pixels, delta_t
        )
        return [metric]

    def _open_camera(self) -> Any:
        if self.mode == "simulated":
            return SyntheticThermalCamera(rpm=self.synthetic_rpm, roi=self.nostril_roi)
        return MLX90640Capture(refresh_hz=self.refresh_hz)

    # --- 캡처 스레드 ------------------------------------------------------ #

    def _capture_loop(self) -> None:
        assert self._camera is not None
        interval = 1.0 / self.refresh_hz

        while not self._stop.is_set():
            started = time.monotonic()
            try:
                frame = self._camera.read()
            except Exception as exc:
                # 프레임 하나를 놓치는 것과 센서가 빠진 것은 다르다. I2C 는 전자가
                # 흔하므로 여기서 죽이지 않고, 창이 안 차면 게이트가 알아서 보류한다.
                log.warning("thermal.read_failed", adapter=self.id, error=str(exc))
                self._stop.wait(interval)
                continue

            mean_c, pixels, delta_t = roi_stats(frame, self.nostril_roi)
            now = time.monotonic()  # 신호 타이밍은 벽시계가 아니라 단조시계를 쓴다

            with self._lock:
                self._roi_pixels = pixels
                self._delta_t = delta_t
                if pixels > 0 and np.isfinite(mean_c):
                    self._times.append(now)
                    self._temps.append(mean_c)
                while self._times and (now - self._times[0]) > self.window_s:
                    self._times.popleft()
                    self._temps.popleft()

            del frame  # 온도 그리드는 여기서 끝. 저장하지 않는다.
            self._stop.wait(max(0.0, interval - (time.monotonic() - started)))

    # --- 추정 ------------------------------------------------------------- #

    def _estimate(
        self,
        times: np.ndarray,
        temps: np.ndarray,
        roi_pixels: int,
        delta_t: float,
    ) -> Metric:
        duration = float(times[-1] - times[0]) if len(times) >= 2 else 0.0
        # 값이 나오려면 두 관문을 다 넘어야 한다. 진행률은 둘 중 덜 찬 쪽이다 —
        # 샘플만 많고 창이 짧아도, 창만 길고 샘플이 적어도 아직 못 낸다.
        progress = min(1.0, duration / MIN_SEC, len(times) / MIN_SAMPLES)

        # --- 게이트: 계산을 시작할 가치가 있는지. 싸고 해석 가능한 것부터 --- #
        # 가시광의 TOO_DARK 에 해당하는 것이 온도 대비 부족이다. 실온이 체온에
        # 가까워지면 날숨과 주변의 온도차가 줄어 신호가 묻힌다.
        if roi_pixels < MIN_ROI_PIXELS:
            return self._hold(None, f"ROI {roi_pixels}px < {MIN_ROI_PIXELS} (너무 멀다)", progress)
        if delta_t < MIN_DELTA_T:
            return self._hold(None, f"온도 대비 {delta_t:.2f} < {MIN_DELTA_T}C", progress)
        if progress < 1.0:
            return self._hold(None, f"창 채우는 중 ({duration:.0f}/{MIN_SEC:.0f}s)", progress)

        _, values = _resample_uniform(times, temps, RESAMPLE_FS)
        if len(values) < MIN_RESAMPLED:
            return self._hold(None, f"리샘플 표본 {len(values)}개", progress)

        signal = quality.bandpass(values, RESAMPLE_FS, quality.BAND_RR)
        if float(np.std(signal)) < 1e-9:
            return self._hold(None, "신호가 평탄함", progress)

        now = time.monotonic()
        dt = 1.0 if self._prev_t is None else max(now - self._prev_t, 1e-3)
        sqi = quality.score_signal(
            signal, RESAMPLE_FS, quality.BAND_RR, bpm_prev=self._prev_bpm, dt=dt
        )
        # 보류했더라도 궤적은 갱신한다. 튀었다 돌아온 값은 양쪽 다 의심스럽다.
        self._prev_bpm = sqi.bpm
        self._prev_t = now

        if not np.isfinite(sqi.bpm):
            return self._hold(sqi.confidence, "대역에서 피크를 못 찾음", progress)
        if sqi.confidence < self._gate:
            return self._hold(sqi.confidence, sqi.hold_reason(), progress)
        return self._metric(round(sqi.bpm, 1), sqi.confidence, "ok", progress)

    def _hold(self, confidence: float | None, reason: str, progress: float) -> Metric:
        """값을 지어내지 않고 보류한다 (README §0-4). 사유는 로그로 남긴다.

        사유 문자열은 화면으로 내보내지 않는다 — UI 문구를 어댑터가 정하게 되기
        때문이다. 화면은 state/confidence/progress 숫자만 받아서 제 말로 쓴다.
        """
        log.debug(
            "thermal.hold", adapter=self.id, reason=reason,
            confidence=confidence, progress=progress,
        )
        return self._metric(None, confidence, "low_quality", progress)

    def _metric(
        self, value: float | None, confidence: float | None, state: State, progress: float
    ) -> Metric:
        return Metric(
            key="rr",
            value=value,
            unit="rpm",
            source=self.id,
            mode=self.mode,
            state=state,
            confidence=None if confidence is None else round(confidence, 3),
            progress=round(progress, 3),
            ts=server_now(),
        )


# --------------------------------------------------------------------------- #
# 캡처 계층
# --------------------------------------------------------------------------- #
class ThermalFrame:
    """32x24 온도 그리드(섭씨) 한 장 + 단조시계 타임스탬프."""

    __slots__ = ("t", "grid")

    def __init__(self, t: float, grid: np.ndarray) -> None:
        self.t = t
        self.grid = grid


def roi_stats(frame: ThermalFrame, roi: tuple[int, int, int, int]) -> tuple[float, int, float]:
    """ROI 내부의 (평균온도, 픽셀수, 최대-최소 온도차).

    프레임 밖으로 나간 부분은 잘라낸다 — 코가 화면 가장자리에 걸쳐도 죽지 않게.
    """
    x, y, w, h = roi
    x0, y0 = max(int(x), 0), max(int(y), 0)
    x1, y1 = min(int(x + w), FRAME_W), min(int(y + h), FRAME_H)
    if x1 <= x0 or y1 <= y0:
        return float("nan"), 0, 0.0
    patch = frame.grid[y0:y1, x0:x1]
    return float(patch.mean()), int(patch.size), float(patch.max() - patch.min())


class SyntheticThermalCamera:
    """하드웨어 없이 신호처리 경로를 돌리기 위한 합성 프레임원.

    배경은 실내 벽 정도(24도)로 두고 ROI 자리에만 체온 근처 ± 호흡 진폭을 얹는다.
    실제 콧구멍 파형은 정현파가 아니지만, 여기서 봐야 하는 것은 "캡처→ROI→추정"
    배선이 맞는가이지 파형 형태의 정확도가 아니다.
    """

    def __init__(
        self,
        rpm: float = 15.0,
        seed: int = 0,
        base_c: float = 33.0,
        amp_c: float = 1.2,
        noise_c: float = 0.15,
        room_c: float = 24.0,
        roi: tuple[int, int, int, int] = DEFAULT_NOSTRIL_ROI,
        dt: float = 0.25,
    ) -> None:
        self.rpm = rpm
        self.rng = np.random.default_rng(seed)
        self.base_c = base_c
        self.amp_c = amp_c
        self.noise_c = noise_c
        self.room_c = room_c
        self.roi = roi
        self.dt = dt
        self._t = 0.0

    def read(self) -> ThermalFrame:
        self._t += self.dt
        grid = np.full((FRAME_H, FRAME_W), self.room_c, dtype=np.float64)
        x, y, w, h = self.roi
        breathing = self.amp_c * np.sin(2 * np.pi * (self.rpm / 60.0) * self._t)
        grid[y : y + h, x : x + w] = self.base_c + breathing
        grid += self.rng.normal(0.0, self.noise_c, grid.shape)
        return ThermalFrame(t=self._t, grid=grid)


class MLX90640Capture:
    """실 하드웨어 래퍼 (adafruit-circuitpython-mlx90640).

    라이브러리와 I2C 버스는 생성자에서 늦게 import 한다. 개발 PC 에는 아예 없으므로
    모듈 최상단에서 import 하면 이 파일을 읽는 것만으로 registry 의 어댑터 로드가
    실패한다 — 다른 하드웨어 드라이버와 같은 규칙이다.
    """

    def __init__(self, refresh_hz: float = 4.0, i2c_freq: int = 400_000) -> None:
        import adafruit_mlx90640
        import board
        import busio

        i2c = busio.I2C(board.SCL, board.SDA, frequency=i2c_freq)
        self._mlx = adafruit_mlx90640.MLX90640(i2c)
        self._mlx.refresh_rate = _nearest_refresh_rate(adafruit_mlx90640, refresh_hz)
        self._buf = [0.0] * FRAME_N

    def read(self) -> ThermalFrame:
        self._mlx.getFrame(self._buf)
        grid = np.asarray(self._buf, dtype=np.float64).reshape(FRAME_H, FRAME_W)
        return ThermalFrame(t=time.monotonic(), grid=grid)


def _nearest_refresh_rate(adafruit_mlx90640: Any, hz: float) -> Any:
    """요청 Hz 에 가장 가까운 라이브러리 상수. 라이브러리가 이산값만 지원한다."""
    table = {
        0.5: "REFRESH_0_5_HZ", 1: "REFRESH_1_HZ", 2: "REFRESH_2_HZ", 4: "REFRESH_4_HZ",
        8: "REFRESH_8_HZ", 16: "REFRESH_16_HZ", 32: "REFRESH_32_HZ", 64: "REFRESH_64_HZ",
    }
    nearest = min(table, key=lambda k: abs(k - hz))
    return getattr(adafruit_mlx90640.RefreshRate, table[nearest])


def _resample_uniform(
    t: np.ndarray, v: np.ndarray, fs: float
) -> tuple[np.ndarray, np.ndarray]:
    """비균일 표본을 균일 격자로.

    이 단계를 빼먹으면 FFT 가 조용히 틀린 답을 낸다. I2C 프레임 간격은 일정하지
    않고, 한 프레임 늦게 온 것이 주파수 축에서는 그냥 다른 주기로 읽힌다.
    """
    if len(t) < 4:
        return np.array([]), np.array([])
    order = np.argsort(t)
    t, v = t[order], v[order]
    grid = np.arange(float(t[0]), float(t[-1]), 1.0 / fs)
    if len(grid) < 8:
        return np.array([]), np.array([])
    return grid, np.interp(grid, t, v)
