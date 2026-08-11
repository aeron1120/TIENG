"""카메라 rPPG (POS) 어댑터.

legacy/tieng_rppg/rppg_demo_v4.py 의 HR 경로를 이식했다. 데모의 UI·호흡추정·
facemesh ROI·참조 저주파제거는 가져오지 않았다. Phase 2 는 실측 HR 하나를
대시보드에 띄우는 것까지고, 나머지는 필요해질 때 legacy 에서 꺼내면 된다.

카메라는 전용 스레드에서 네이티브 fps 로 계속 돈다. read() 가 1Hz 로 불리는
것과 무관하게 12초 창이 채워져야 하기 때문이다. cv2 블로킹 호출은 전부 그
스레드 안에 있고, scipy 추정은 executor 로 뺀다 (README §10).

프레임 소스는 두 가지다. 파이의 CSI 카메라는 libcamera 전용이라 picamera2 로 열고,
개발 PC 의 USB 웹캠은 cv2 로 연다. 둘 다 read()/release() 만 내주므로 캡처 루프는
어느 쪽이 물렸는지 모른다.

원본 영상은 저장하지 않는다. 프레임은 ROI 평균 RGB 3개 숫자로 줄인 뒤 즉시
버린다 (README §1 비목표).

미리보기(preview_jpeg)는 그 규칙 안에서 동작한다. 보는 사람이 있을 때만 축소본을
JPEG 로 만들어 메모리에 하나 들고 있다가 다음 프레임이 오면 덮어쓴다. 디스크에
쓰지 않고 LAN 밖으로도 나가지 않는다.
"""

from __future__ import annotations

import asyncio
import platform
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import structlog
from scipy.signal import butter, detrend, filtfilt, welch

from api.schemas import Metric, Mode, State, server_now
from core import quality, thresholds
from core.adapters.base import SensorAdapter

log = structlog.get_logger(__name__)

WINDOW_SEC = 12.0  # 분석 창. 짧으면 BPM이 튄다 (README §8)
MIN_SEC = 8.0  # 이보다 짧으면 추정하지 않는다
MIN_SAMPLES = 30
FS_RESAMPLE = 30.0  # 프레임 간격이 불균일하므로 균일 격자로 다시 샘플링
BPM_MIN = 42.0
BPM_MAX = 180.0
FULL_BAND_HZ = (0.3, 4.0)  # 에너지비 분모(전체 생리 대역)
MIN_SKIN_PIXELS = 150
JITTER_SCALE_PX = 6.0  # 이만큼 흔들리면 jitter_norm = 1
FACE_DETECT_SEC = 0.5  # 매 프레임 검출은 Pi에서 FPS를 깎는다
READ_FAIL_LIMIT = 30  # 연속 실패가 이만큼이면 카메라가 빠진 것으로 본다
SETTLE_SEC = 2.0  # 자동 노출/화벨이 수렴할 때까지 기다렸다가 잠근다

# --- 안정화 -------------------------------------------------------------- #
# legacy 데모(rppg_demo_v4.py)에는 SQI 게이트 말고도 jump guard / 출력 EMA /
# 라벨 히스테리시스가 있었는데 Phase 2 이식에서 신호 코어만 가져왔다. 그게 없으면
# 12초 창을 1초마다 다시 풀 때 나오는 흔들림이 그대로 화면에 나간다.
EMA_ALPHA = 0.3  # 프레임 단위 관측치용. jitter 와 같은 값 (30fps 에서 시간상수 ~0.3초)
BPM_SMOOTH_ALPHA = 0.3  # 표시 BPM 용. legacy 의 --smooth-alpha 와 같은 자리
GATE_HYSTERESIS = 0.08  # 게이트 진입/이탈 dead-band. legacy hysteresis_label 과 같은 값
JUMP_RELEASE_S = 10.0  # 점프 거부가 이만큼 이어지면 기준값이 틀린 것으로 보고 풀어 준다

PREVIEW_WIDTH = 320  # 얼굴이 ROI 안에 들어왔는지 보는 용도라 이 이상 필요 없다
PREVIEW_FPS = 10.0
PREVIEW_QUALITY = 70
PREVIEW_LINGER_SEC = 3.0  # 마지막 요청 후 이만큼 지나면 인코딩을 멈춘다
_PREVIEW_ROI = (89, 160, 197)  # BGR. 화면 강조색 #c5a059 와 같은 색
_PREVIEW_FACE = (120, 120, 120)


class RppgAdapter(SensorAdapter):
    provides = ["hr"]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        camera_index: int = 0,
        width: int = 640,
        height: int = 480,
        window_s: float = WINDOW_SEC,
        backend: str = "opencv",
        settle_s: float = SETTLE_SEC,
        thresholds_path: str = str(thresholds.DEFAULT_PATH),
    ) -> None:
        super().__init__(id, mode)
        # 자동 감지하지 않는다. USB 와 CSI 가 둘 다 꽂힌 기기에서 어느 쪽을 고를지
        # 규칙이 지저분해지고, device.yaml 은 어차피 기기별 파일이라 적어 두는 편이
        # 낫다. 오타가 조용히 opencv 로 떨어지면 엉뚱한 카메라가 열리므로 여기서 막는다.
        if backend not in ("opencv", "picamera2"):
            raise ValueError(f"backend 는 opencv 또는 picamera2 여야 한다: {backend!r}")
        self.camera_index = camera_index
        self.width = width
        self.height = height
        self.window_s = window_s
        self.backend = backend
        self.settle_s = settle_s
        self.thresholds_path = Path(thresholds_path)

        self._cap: Any = None
        self._detector: Any = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        # 아래는 전부 _lock 으로 보호한다. 캡처 스레드가 쓰고 read() 가 읽는다.
        self._times: deque[float] = deque()
        self._rgbs: deque[tuple[float, float, float]] = deque()
        self._jitter_ema = 0.0
        # None 은 "아직 표본이 없다". 0.0 으로 시작하면 ROI 를 되찾은 뒤에도 한동안
        # 낮은 값이 남아 멀쩡한 창이 보류된다.
        self._skin_ratio: float | None = None
        self._brightness: float | None = None
        self._fault: str | None = None
        self._preview: bytes | None = None
        self._preview_until = 0.0  # 이 시각까지는 보는 사람이 있다고 본다

        self._gate = 0.4
        # 안정화 상태. read() 가 순차로만 불리므로 lock 을 걸지 않는다.
        self._prev_bpm: float | None = None  # 받아들인 궤적. 거부된 후보는 넣지 않는다
        self._prev_t: float | None = None
        self._display_bpm: float | None = None
        self._reject_since: float | None = None
        self._emitting = False  # 게이트를 통과한 상태인가 (히스테리시스용)

    # --- 수명주기 --------------------------------------------------------- #

    async def start(self) -> None:
        self._gate = thresholds.load(self.thresholds_path).confidence_min
        loop = asyncio.get_running_loop()
        self._cap = await loop.run_in_executor(None, self._open_camera)
        if self._cap is None:
            raise RuntimeError(f"카메라 {self.camera_index} 를 열 수 없다")

        self._detector = _build_face_detector()
        if self._detector is None:
            # 얼굴 검출이 없어도 화면 중앙 가이드 박스로 동작한다. 정확도만 떨어진다.
            log.warning("rppg.no_face_detector", adapter=self.id)

        self._stop.clear()
        self._thread = threading.Thread(
            target=self._capture_loop, name=f"rppg-{self.id}", daemon=True
        )
        self._thread.start()
        log.info("rppg.started", adapter=self.id, gate=self._gate, window_s=self.window_s)

    async def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        with self._lock:
            self._preview = None

    async def read(self) -> list[Metric]:
        with self._lock:
            if self._fault is not None:
                raise RuntimeError(self._fault)  # registry 가 state=error 로 강등한다
            times = np.asarray(self._times, dtype=np.float64)
            rgbs = np.asarray(self._rgbs, dtype=np.float64)
            jitter = self._jitter_ema
            # 표본이 아직 없으면 0 으로 본다. 그 상태는 MIN_SAMPLES 게이트가 먼저 잡는다.
            skin_ratio = self._skin_ratio or 0.0
            brightness = self._brightness or 0.0

        loop = asyncio.get_running_loop()
        metric = await loop.run_in_executor(
            None, self._estimate, times, rgbs, jitter, skin_ratio, brightness
        )
        return [metric]

    # --- 캡처 스레드 ------------------------------------------------------ #

    def _open_camera(self) -> Any:
        """프레임 소스를 연다. 어느 쪽이든 read()/release() 만 내준다."""
        if self.backend == "picamera2":
            return _open_picamera2(self.camera_index, self.width, self.height, self.settle_s)
        return self._open_opencv()

    def _open_opencv(self) -> Any:
        backends: list[int] = []
        if platform.system().lower().startswith("win"):
            backends += [cv2.CAP_DSHOW, cv2.CAP_MSMF]
        backends.append(0)
        for backend in backends:
            cap = (
                cv2.VideoCapture(self.camera_index, backend)
                if backend
                else cv2.VideoCapture(self.camera_index)
            )
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
                return cap
            cap.release()
        return None

    def _capture_loop(self) -> None:
        assert self._cap is not None
        face_box: tuple[int, int, int, int] | None = None
        last_detect = 0.0
        prev_center: tuple[float, float] | None = None
        failures = 0
        next_preview = 0.0

        while not self._stop.is_set():
            ok, frame = self._cap.read()
            if not ok or frame is None:
                failures += 1
                if failures >= READ_FAIL_LIMIT:
                    with self._lock:
                        self._fault = "카메라 프레임을 연속으로 못 읽었다"
                        # 마지막 프레임을 버린다. 안 버리면 카메라가 빠진 뒤에
                        # 화면을 연 사람에게 죽은 프레임이 실시간 영상인 것처럼
                        # 나간다. 값을 지어내지 않는 것과 같은 이유다 (README §0-4).
                        self._preview = None
                    return
                time.sleep(0.01)
                continue
            failures = 0

            now = time.monotonic()  # 신호 타이밍은 벽시계가 아니라 단조시계를 쓴다
            height, width = frame.shape[:2]

            if now - last_detect >= FACE_DETECT_SEC:
                face_box = _detect_face(self._detector, frame)
                last_detect = now

            roi = _select_hr_roi(frame, face_box, width, height)

            jitter_norm = 0.0
            if roi.center is not None and prev_center is not None:
                moved = float(
                    np.hypot(roi.center[0] - prev_center[0], roi.center[1] - prev_center[1])
                )
                jitter_norm = min(1.0, moved / JITTER_SCALE_PX)
            prev_center = roi.center if roi.center is not None else prev_center

            with self._lock:
                # EMA 로 눌러야 한 프레임 튄 것 때문에 통째로 보류되지 않는다.
                self._jitter_ema = 0.7 * self._jitter_ema + 0.3 * jitter_norm
                if roi.rgb is not None:
                    self._times.append(now)
                    self._rgbs.append(roi.rgb)
                    # skin_ratio 와 brightness 도 같은 이유로 누른다. 얼굴 검출이
                    # FACE_DETECT_SEC 마다만 도니 그 사이 박스가 흔들리면 ROI 가
                    # 움직이고, read() 가 1Hz 로 집어 가는 것은 마지막 한 프레임의
                    # 값이다. skin_ratio 에는 하드 플로어가 걸려 있어서 0.100 ->
                    # 0.099 한 번에 confidence 가 0.89 에서 0 으로 떨어진다 —
                    # 12초 창은 멀쩡한데 한 프레임 때문에 보류되는 것이다.
                    self._skin_ratio = _ema(self._skin_ratio, roi.skin_ratio)
                    self._brightness = _ema(self._brightness, roi.brightness)
                while self._times and (now - self._times[0]) > self.window_s:
                    self._times.popleft()
                    self._rgbs.popleft()
                wanted = now < self._preview_until

            # 미리보기는 보는 사람이 있을 때만 만든다. 아무도 안 보는데 매 프레임
            # JPEG 을 굽는 건 Pi 에서 그대로 FPS 손해다.
            if wanted and now >= next_preview:
                next_preview = now + 1.0 / PREVIEW_FPS
                self._publish_preview(frame, face_box, width, height)

            del frame  # 원본 프레임은 여기서 끝. 저장하지 않는다.

    # --- 미리보기 --------------------------------------------------------- #

    def request_preview(self) -> None:
        with self._lock:
            self._preview_until = time.monotonic() + PREVIEW_LINGER_SEC

    def preview_jpeg(self) -> bytes | None:
        with self._lock:
            return self._preview

    def _publish_preview(
        self,
        frame: np.ndarray,
        face_box: tuple[int, int, int, int] | None,
        width: int,
        height: int,
    ) -> None:
        """지금 프레임의 축소본을 JPEG 으로 만들어 하나만 들고 있는다.

        측정에 쓰는 ROI 를 같이 그린다. 신뢰도가 낮을 때 "왜"를 화면에서 바로
        알 수 있어야 한다 — 얼굴을 놓쳤는지, 박스 밖으로 나갔는지가 보인다.
        """
        scale = PREVIEW_WIDTH / float(width)
        small = cv2.resize(frame, (PREVIEW_WIDTH, max(1, round(height * scale))))

        def box(rect: tuple[int, int, int, int], color: tuple[int, int, int]) -> None:
            x, y, w, h = rect
            cv2.rectangle(
                small,
                (round(x * scale), round(y * scale)),
                (round((x + w) * scale), round((y + h) * scale)),
                color,
                1,
            )

        if face_box is not None:
            box(face_box, _PREVIEW_FACE)
        for rect in _roi_candidates(face_box, width, height):
            box(rect, _PREVIEW_ROI)

        # 거울상으로 뒤집는다. 화면을 보면서 자세를 잡는 용도라 좌우가 그대로면
        # 오른쪽으로 움직였는데 화면은 왼쪽으로 가서 맞추기가 어렵다.
        ok, buf = cv2.imencode(
            ".jpg", cv2.flip(small, 1), [int(cv2.IMWRITE_JPEG_QUALITY), PREVIEW_QUALITY]
        )
        if not ok:
            return
        with self._lock:
            self._preview = buf.tobytes()

    # --- 추정 ------------------------------------------------------------- #

    def _estimate(
        self,
        times: np.ndarray,
        rgbs: np.ndarray,
        jitter_norm: float,
        skin_ratio: float,
        brightness: float,
    ) -> Metric:
        # 값이 나오려면 두 관문을 다 넘어야 한다. 진행률은 둘 중 덜 찬 쪽이다 —
        # 샘플만 많고 창이 짧아도, 창만 길고 샘플이 적어도 아직 못 낸다.
        duration = float(times[-1] - times[0]) if len(times) >= 2 else 0.0
        progress = min(1.0, duration / MIN_SEC, len(times) / MIN_SAMPLES)

        if len(times) < MIN_SAMPLES or rgbs.shape[0] != len(times):
            return self._hold(None, "얼굴/피부 샘플 모으는 중", progress)

        if duration < MIN_SEC:
            return self._hold(None, f"창 채우는 중 ({duration:.0f}/{MIN_SEC:.0f}s)", progress)

        n = max(int(duration * FS_RESAMPLE), int(MIN_SEC * FS_RESAMPLE))
        t_uniform = np.linspace(times[0], times[-1], n)
        rgb_uniform = np.stack(
            [np.interp(t_uniform, times, rgbs[:, ch]) for ch in range(3)], axis=1
        )

        try:
            pulse = detrend(_pos(rgb_uniform))
            pulse = _bandpass(pulse, FS_RESAMPLE, BPM_MIN, BPM_MAX)
        except Exception as exc:
            log.warning("rppg.signal_error", adapter=self.id, error=str(exc))
            return self._hold(None, "신호 처리 실패", progress)

        if not np.all(np.isfinite(pulse)) or float(np.std(pulse)) < 1e-8:
            return self._hold(None, "신호가 평탄함", progress)

        pulse = (pulse - np.mean(pulse)) / (np.std(pulse) + 1e-8)

        nperseg = max(min(len(pulse), int(FS_RESAMPLE * 8)), 16)
        freqs, psd = welch(
            pulse, fs=FS_RESAMPLE, nperseg=nperseg, noverlap=nperseg // 2, window="hann"
        )

        band_mask = (freqs >= BPM_MIN / 60.0) & (freqs <= BPM_MAX / 60.0)
        band_idx = np.where(band_mask)[0]
        if len(band_idx) == 0:
            return self._hold(None, "HR 대역 없음", progress)

        peak_idx = int(band_idx[int(np.argmax(psd[band_idx]))])
        bpm = float(_parabolic_peak(psd, peak_idx) * float(freqs[1] - freqs[0]) * 60.0)

        # 주피크 ±2 bin 을 뺀 나머지의 중앙값을 잡음 바닥으로 본다.
        band_values = psd[band_idx]
        noise = band_values[np.abs(band_idx - peak_idx) > 2]
        floor = float(np.median(noise)) if len(noise) else float(np.median(band_values))
        peak_snr_db = float(10.0 * np.log10((psd[peak_idx] + 1e-12) / (floor + 1e-12)))

        full_mask = (freqs >= FULL_BAND_HZ[0]) & (freqs <= FULL_BAND_HZ[1])
        energy_ratio = float(psd[band_mask].sum()) / (float(psd[full_mask].sum()) + 1e-12)

        q = quality.score(
            peak_snr_db=peak_snr_db,
            band_energy_ratio=energy_ratio,
            skin_ratio=skin_ratio,
            brightness=brightness,
            jitter_norm=jitter_norm,
        )
        if not self._passes_gate(q.confidence):
            return self._hold(q.confidence, q.hold_reason(), progress)

        accepted = self._guard(bpm, time.monotonic())
        if accepted is None:
            # 품질 미달이 아니다. 게이트를 통과한 신호인데 값만 버린 것이라 상태를
            # 나눈다 (api/schemas.py 의 State).
            return self._hold(
                q.confidence,
                f"생리학적으로 불가능한 점프 ({bpm:.0f}bpm)",
                progress,
                state="rejected",
            )
        return self._metric(round(accepted, 1), q.confidence, "ok", progress)

    # --- 안정화 ----------------------------------------------------------- #

    def _passes_gate(self, confidence: float) -> bool:
        """게이트에 dead-band 를 둔다.

        임계값 하나로 자르면 경계 근처를 오가는 confidence 때문에 표시와 보류가 매 틱
        깜빡인다. 데모에서 이러면 고장난 것처럼 보인다. 내보내는 값을 정하는 데만
        쓰고 confidence 숫자 자체는 건드리지 않는다 — L1 은 원래 값을 봐야 한다.
        """
        need = self._gate - GATE_HYSTERESIS if self._emitting else self._gate + GATE_HYSTERESIS
        self._emitting = confidence >= need
        return self._emitting

    def _guard(self, bpm: float, now: float) -> float | None:
        """생리학적으로 불가능한 점프를 막고, 통과한 값을 눌러 표시값으로 만든다.

        점수로 벌하는 것과 다르다. 점프를 confidence 성분으로만 다루면 그 창 하나만
        벌하고 그 뒤로는 바뀐 값이 기준이 되어, 움직임 배음에 락온한 뒤에는 틀린 값이
        '일관된' 값이 된다 (합성 실측: 73 -> 100bpm 락온 뒤 confidence 0.95). guard 는
        애초에 그 값으로 가지 않는다.

        거부가 오래 이어지면 풀어 준다. 사람이 나갔다 왔거나 우리 기준값이 애초에
        틀렸을 수 있고, 그때 영구히 멎으면 그게 더 나쁘다.
        """
        if self._prev_bpm is None or self._prev_t is None:
            return self._smooth(bpm, now)

        allowed = quality.BAND_HR.max_delta_per_sec * max(now - self._prev_t, 1e-3)
        if abs(bpm - self._prev_bpm) <= allowed:
            self._reject_since = None
            return self._smooth(bpm, now)

        if self._reject_since is None:
            self._reject_since = now
        elif now - self._reject_since >= JUMP_RELEASE_S:
            log.info("rppg.jump_released", adapter=self.id, bpm=round(bpm, 1))
            self._reject_since = None
            self._display_bpm = None  # 새 수준으로 갈아탄다. 옛 값에서 끌고 오지 않는다
            return self._smooth(bpm, now)
        return None

    def _smooth(self, bpm: float, now: float) -> float:
        """표시값 EMA. 12초 창을 1초마다 다시 풀면 나오는 잔떨림을 없앤다."""
        self._prev_bpm = bpm
        self._prev_t = now
        self._display_bpm = (
            bpm
            if self._display_bpm is None
            else (1.0 - BPM_SMOOTH_ALPHA) * self._display_bpm + BPM_SMOOTH_ALPHA * bpm
        )
        return self._display_bpm

    def _hold(
        self,
        confidence: float | None,
        reason: str,
        progress: float,
        state: State = "low_quality",
    ) -> Metric:
        """값을 지어내지 않고 보류한다 (README §0-4). 사유는 로그로 남긴다.

        progress 는 화면으로 나간다. 사유 문자열을 그대로 보내지 않는 이유는
        UI 문구를 어댑터가 정하게 되기 때문이다 — 화면은 숫자만 받아서 제 말로 쓴다.

        state 를 받는 이유는 보류 사유가 두 종류이기 때문이다. 기본은 신호가 나쁜
        것이고, 점프 거부는 신호가 멀쩡한데 값만 버린 것이라 rejected 로 나간다.
        """
        log.debug(
            "rppg.hold", adapter=self.id, reason=reason, confidence=confidence, progress=progress
        )
        return self._metric(None, confidence, state, progress)

    def _metric(
        self, value: float | None, confidence: float | None, state: State, progress: float
    ) -> Metric:
        return Metric(
            key="hr",
            value=value,
            unit="bpm",
            source=self.id,
            mode=self.mode,
            state=state,
            confidence=confidence,
            progress=round(progress, 3),
            ts=server_now(),
        )


# --------------------------------------------------------------------------- #
# 카메라 백엔드
# --------------------------------------------------------------------------- #
class _Picamera2Capture:
    """Picamera2 를 cv2.VideoCapture 처럼 보이게 감싼다.

    캡처 루프와 stop() 은 read()/release() 만 쓴다. 그 두 개만 맞춰 주면 나머지
    코드는 어느 백엔드로 열렸는지 몰라도 된다.
    """

    __slots__ = ("_camera",)

    def __init__(self, camera: Any) -> None:
        self._camera = camera

    def read(self) -> tuple[bool, np.ndarray | None]:
        # 여기서 예외가 새어 나가면 캡처 스레드가 조용히 죽는다. 그러면 _fault 가
        # 안 잡혀 read() 는 멎은 창을 계속 내보낸다 — 실패는 실패로 보여야 한다.
        try:
            return True, self._camera.capture_array()
        except Exception as exc:
            log.warning("rppg.picamera2_read_failed", error=str(exc))
            return False, None

    def release(self) -> None:
        self._camera.stop()
        self._camera.close()


def _open_picamera2(
    camera_index: int, width: int, height: int, settle_s: float
) -> _Picamera2Capture:
    """CSI 리본 카메라 (Bookworm).

    이 카메라도 /dev/video0 으로 잡히기는 하지만 그건 디베이어 전 raw 프레임이라
    cv2.VideoCapture 로는 쓸 수 없다. libcamera 를 거치는 Picamera2 로 연다.

    picamera2 는 libcamera 파이썬 바인딩에 묶여 있어 apt 로만 깔린다
    (python3-picamera2). pi extras 에 넣으면 pip 설치가 통째로 깨지므로 넣지 않고,
    venv 를 --system-site-packages 로 만들어 가져온다 (docs/hardware.md §0).
    여기서 늦게 import 하는 것은 다른 드라이버와 같은 이유다 — 없으면 이 카드만
    죽고 나머지는 그대로 돈다.
    """
    from picamera2 import Picamera2

    # 카메라가 없으면 Picamera2 는 "list index out of range" 로 죽는다. 그 메시지만
    # 보고는 리본이 안 꽂힌 건지 인덱스가 틀린 건지 알 수 없으므로 먼저 세어 본다.
    found = Picamera2.global_camera_info()
    if camera_index >= len(found):
        raise RuntimeError(
            f"libcamera 가 잡은 카메라는 {len(found)}대인데 camera_index={camera_index} 를 찾는다. "
            "리본이 제대로 꽂혔는지, rpicam-hello --list-cameras 에 보이는지 확인할 것"
        )

    camera = Picamera2(camera_index)
    # 포맷 이름은 메모리에 담기는 순서와 반대다. "RGB888" 로 잡아야 실제 바이트가
    # B,G,R 순으로 와서 cv2 가 기대하는 배열이 그대로 나온다. 뒤집히면 POS 도
    # 피부 마스크도 조용히 틀리므로, 파이에서 미리보기를 열어 피부가 파랗게 보이지
    # 않는지 눈으로 확인할 것.
    camera.configure(
        camera.create_video_configuration(
            main={"size": (width, height), "format": "RGB888"},
            # 추정은 어차피 30Hz 격자로 다시 샘플링한다(FS_RESAMPLE). 그보다 빨리
            # 받아 봐야 파이에서 CPU 만 먹는다.
            controls={"FrameDurationLimits": (33333, 33333)},
        )
    )
    camera.start()
    _freeze(camera, settle_s)
    return _Picamera2Capture(camera)


def _freeze(camera: Any, settle_s: float) -> None:
    """노출·화이트밸런스·초점을 고정한다.

    rPPG 가 보는 건 피부 RGB 의 0.1~1% 변동이라, 자동 보정이 매 프레임 개입하면
    신호보다 큰 잡음이 얹힌다 (legacy/tieng_rppg/confidence/example_wiring.py 가
    웹캠에서 조심할 것 첫 번째로 꼽던 항목이다).

    고정값을 코드에 박지 않고 settle_s 동안 수렴시킨 뒤 그 값을 읽어 잠근다. 그래야
    방 밝기가 달라도 따라간다. 웹캠에서는 이게 드라이버마다 먹거나 안 먹었지만
    (rppg_demo_v4 의 --force-lock-exposure) picamera2 에서는 확정적이다.
    """
    from libcamera import controls as libcontrols  # picamera2 가 딸고 온다

    available = camera.camera_controls

    # 초점부터. AF 가 계속 초점을 찾으면 ROI 선명도가 프레임마다 달라져 그대로
    # 신호에 들어온다. 한 번 맞추고 그 자리에 세운다.
    if "AfMode" in available:
        camera.set_controls({"AfMode": libcontrols.AfModeEnum.Auto})
        camera.autofocus_cycle()

    time.sleep(settle_s)
    md = camera.capture_metadata()

    locked: dict[str, Any] = {"AeEnable": False, "AwbEnable": False}
    for key in ("ExposureTime", "AnalogueGain", "ColourGains"):
        if key in md:
            locked[key] = md[key]
    if "AfMode" in available:
        locked["AfMode"] = libcontrols.AfModeEnum.Manual
        if "LensPosition" in md:
            locked["LensPosition"] = md["LensPosition"]
    camera.set_controls(locked)

    log.info(
        "rppg.camera_locked",
        exposure_us=md.get("ExposureTime"),
        gain=md.get("AnalogueGain"),
        lens=md.get("LensPosition"),
    )


# --------------------------------------------------------------------------- #
# 신호 처리 (rppg_demo_v4.py 에서 이식)
# --------------------------------------------------------------------------- #
def _ema(previous: float | None, sample: float) -> float:
    """첫 표본은 그대로 받는다.

    0 에서 시작하면 ROI 를 되찾은 뒤에도 한동안 낮은 값이 남아, 멀쩡한 창이 하드
    플로어에 걸려 보류된다.
    """
    if previous is None:
        return sample
    return (1.0 - EMA_ALPHA) * previous + EMA_ALPHA * sample


def _pos(rgb: np.ndarray) -> np.ndarray:
    """POS. RGB 시계열에서 맥파 후보를 뽑는다."""
    mean = np.mean(rgb, axis=0)
    mean[mean == 0] = 1e-8
    cn = rgb / mean
    s = cn @ np.array([[0.0, 1.0, -1.0], [-2.0, 1.0, 1.0]]).T
    s1, s2 = s[:, 0], s[:, 1]
    std2 = float(np.std(s2))
    alpha = float(np.std(s1)) / std2 if std2 > 1e-8 else 0.0
    h = s1 + alpha * s2
    return np.asarray(h - np.mean(h), dtype=np.float64)


def _bandpass(signal: np.ndarray, fs: float, bpm_min: float, bpm_max: float) -> np.ndarray:
    nyquist = 0.5 * fs
    low = max(0.01, bpm_min / 60.0) / nyquist
    high = min(bpm_max / 60.0 / nyquist, 0.99)
    if not 0 < low < high < 1:
        raise ValueError("invalid bandpass range")
    b, a = butter(3, [low, high], btype="band")
    return np.asarray(filtfilt(b, a, signal), dtype=np.float64)


def _parabolic_peak(magnitude: np.ndarray, index: int) -> float:
    """peak 주변 3점 보간. bin 해상도보다 잘게 BPM 을 잡는다."""
    if index <= 0 or index >= len(magnitude) - 1:
        return float(index)
    left, center, right = magnitude[index - 1], magnitude[index], magnitude[index + 1]
    denom = left - 2.0 * center + right
    if abs(denom) < 1e-12:
        return float(index)
    return float(index + np.clip(0.5 * (left - right) / denom, -0.5, 0.5))


# YCrCb 피부 범위. cv2 는 (Y, Cr, Cb) 순서로 채널을 준다.
_SKIN_LO = np.array([40, 133, 77], dtype=np.uint8)
_SKIN_HI = np.array([250, 173, 127], dtype=np.uint8)


def _skin_mask(bgr: np.ndarray) -> np.ndarray:
    """YCrCb 피부 마스크 (0/255 uint8).

    데모 원본은 float64 로 직접 계산했지만 여기서는 cv2 에 맡긴다. 프레임마다
    ROI 3개를 도는 경로라 SIMD 로 3.6배 빠르고, 실제 피부톤에서는 결과가
    비트 단위로 같다. uint8 로 돌려주면 아래 cv2.mean 의 mask 인자로 바로 쓴다.
    """
    return cv2.inRange(cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb), _SKIN_LO, _SKIN_HI)


class _Roi:
    __slots__ = ("rgb", "skin_ratio", "brightness", "center")

    def __init__(
        self,
        rgb: tuple[float, float, float] | None,
        skin_ratio: float,
        brightness: float,
        center: tuple[float, float] | None,
    ) -> None:
        self.rgb = rgb
        self.skin_ratio = skin_ratio
        self.brightness = brightness
        self.center = center


def _clamp_box(
    box: tuple[int, int, int, int], width: int, height: int
) -> tuple[int, int, int, int]:
    x, y, w, h = box
    x = max(0, min(int(x), width - 1))
    y = max(0, min(int(y), height - 1))
    return x, y, max(1, min(int(w), width - x)), max(1, min(int(h), height - y))


def _roi_candidates(
    face_box: tuple[int, int, int, int] | None, width: int, height: int
) -> list[tuple[int, int, int, int]]:
    """이마 + 양 볼. 얼굴이 없으면 화면 중앙 가이드 박스 하나."""
    if face_box is None:
        gw, gh = int(width * 0.28), int(height * 0.20)
        return [_clamp_box(((width - gw) // 2, int(height * 0.22), gw, gh), width, height)]
    x, y, w, h = face_box
    forehead = (x + int(0.30 * w), y + int(0.08 * h), int(0.40 * w), int(0.16 * h))
    left_cheek = (x + int(0.18 * w), y + int(0.42 * h), int(0.24 * w), int(0.22 * h))
    right_cheek = (x + int(0.58 * w), y + int(0.42 * h), int(0.24 * w), int(0.22 * h))
    return [_clamp_box(box, width, height) for box in (forehead, left_cheek, right_cheek)]


def _select_hr_roi(
    frame: np.ndarray,
    face_box: tuple[int, int, int, int] | None,
    width: int,
    height: int,
) -> _Roi:
    """후보 ROI 를 피부 픽셀 수로 가중 평균한다. 한 곳이 가려져도 나머지로 버틴다."""
    rgbs: list[np.ndarray] = []
    counts: list[int] = []
    best: tuple[int, float, float, tuple[float, float]] | None = None

    for rx, ry, rw, rh in _roi_candidates(face_box, width, height):
        sub = frame[ry : ry + rh, rx : rx + rw]
        if sub.size == 0:
            continue
        mask = _skin_mask(sub)
        count = int(cv2.countNonZero(mask))
        if count < MIN_SKIN_PIXELS:
            continue
        # 채널별 boolean 인덱싱은 매번 배열을 복사한다. cv2.mean 은 한 번에
        # 세 채널 평균을 내고 8배 빠르며 값은 동일하다.
        b, g, r, _ = cv2.mean(sub, mask=mask)
        rgbs.append(np.array([r, g, b], dtype=np.float64))
        counts.append(count)
        ratio = count / float(mask.size)
        if best is None or count > best[0]:
            best = (count, ratio, (r + g + b) / 3.0, (rx + rw / 2.0, ry + rh / 2.0))

    if best is None:
        return _Roi(None, 0.0, 0.0, None)

    combined = np.average(np.stack(rgbs), axis=0, weights=np.asarray(counts, dtype=np.float64))
    return _Roi(
        (float(combined[0]), float(combined[1]), float(combined[2])),
        best[1],
        best[2],
        best[3],
    )


def _build_face_detector() -> Any:
    """Haar cascade 로더.

    cv2 에 XML 경로를 그대로 넘기면 Windows 에서 경로에 한글이 섞였을 때 조용히
    실패한다. FileStorage 가 ANSI 코드페이지로 경로를 여는 탓이다. 파이썬으로 읽어
    메모리로 넘기면 경로 인코딩을 타지 않는다.
    """
    try:
        # cv2.data 는 런타임에만 있고 스텁에는 없다.
        cascade_dir = Path(cv2.data.haarcascades)  # type: ignore[attr-defined]
        path = cascade_dir / "haarcascade_frontalface_default.xml"
        detector = cv2.CascadeClassifier()
        storage = cv2.FileStorage(
            path.read_text(encoding="utf-8"),
            cv2.FILE_STORAGE_READ | cv2.FILE_STORAGE_MEMORY,
        )
        if detector.read(storage.getFirstTopLevelNode()) and not detector.empty():
            return detector
        log.warning("rppg.cascade_empty", path=str(path))
    except Exception as exc:
        log.warning("rppg.cascade_load_failed", error=str(exc))
    return None


def _detect_face(detector: Any, frame: np.ndarray) -> tuple[int, int, int, int] | None:
    if detector is None:
        return None
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = detector.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=5, minSize=(80, 80))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: int(f[2]) * int(f[3]))
    return int(x), int(y), int(w), int(h)
