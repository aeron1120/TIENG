"""ROI 평균 RGB 시계열 → 심박. 카메라를 모른다.

core/adapters/rppg.py 에서 떼어낸 것이다. 옮긴 이유는 두 가지다.

1. 프레임 소스가 카메라 하나가 아니게 됐다. 브라우저가 자기 기기 카메라에서
   ROI 평균 RGB 만 뽑아 올려도 같은 계산을 태울 수 있어야 한다 — 계산이 rppg.py
   안에 있으면 그러려고 cv2 까지 끌고 와야 한다.
2. rppg.py 는 최상단에서 cv2 를 import 한다. 카메라 없는 서버(Render)에는
   libGL 이 없어서 그 import 만으로 앱이 통째로 안 뜬다.

여기 있는 것은 신호처리와 안정화뿐이다. 얼굴 검출·피부 마스크·미리보기처럼
픽셀을 봐야 하는 일은 rppg.py 에 남는다.

숫자는 옮기면서 한 자리도 바꾸지 않았다. 옥시미터로 검증한 경로라
(legacy/tieng_rppg/validation) 값이 달라지면 그 검증이 무효가 된다.
"""

from __future__ import annotations

import time

import numpy as np
import structlog
from scipy.signal import butter, detrend, filtfilt, welch

from api.schemas import Metric, Mode, State, server_now
from core import quality

log = structlog.get_logger(__name__)

WINDOW_SEC = 12.0  # 분석 창. 짧으면 BPM이 튄다 (README §8)
MIN_SEC = 8.0  # 이보다 짧으면 추정하지 않는다
MIN_SAMPLES = 30
FS_RESAMPLE = 30.0  # 프레임 간격이 불균일하므로 균일 격자로 다시 샘플링
BPM_MIN = 42.0
BPM_MAX = 180.0
FULL_BAND_HZ = (0.3, 4.0)  # 에너지비 분모(전체 생리 대역)

# --- 안정화 -------------------------------------------------------------- #
# legacy 데모(rppg_demo_v4.py)에는 SQI 게이트 말고도 jump guard / 출력 EMA /
# 라벨 히스테리시스가 있었는데 Phase 2 이식에서 신호 코어만 가져왔다. 그게 없으면
# 12초 창을 1초마다 다시 풀 때 나오는 흔들림이 그대로 화면에 나간다.
BPM_SMOOTH_ALPHA = 0.3  # 표시 BPM 용. legacy 의 --smooth-alpha 와 같은 자리
GATE_HYSTERESIS = 0.08  # 게이트 진입/이탈 dead-band. legacy hysteresis_label 과 같은 값
JUMP_RELEASE_S = 10.0  # 점프 거부가 이만큼 이어지면 기준값이 틀린 것으로 보고 풀어 준다


class HrEstimator:
    """RGB 시계열 하나를 심박 Metric 으로 바꾼다.

    상태를 들고 있다 (점프 가드 기준값, 표시 EMA, 게이트 히스테리시스). 그래서
    측정 대상마다 하나씩 있어야 한다 — 두 사람의 심박을 한 인스턴스에 태우면
    한쪽의 이전 값이 다른 쪽의 점프 판정 기준이 된다.

    estimate() 는 블로킹이다 (scipy). 호출하는 쪽에서 executor 로 넘긴다.
    """

    def __init__(self, source: str, mode: Mode, gate: float = 0.4) -> None:
        self.source = source  # Metric.source 로 나간다. 어느 어댑터가 낸 값인가
        self.mode = mode
        self.gate = gate

        self._prev_bpm: float | None = None  # 받아들인 궤적. 거부된 후보는 넣지 않는다
        self._prev_t: float | None = None
        self._display_bpm: float | None = None
        self._reject_since: float | None = None
        self._emitting = False  # 게이트를 통과한 상태인가 (히스테리시스용)

    def estimate(
        self,
        times: np.ndarray,
        rgbs: np.ndarray,
        jitter_norm: float,
        skin_ratio: float,
        brightness: float,
        now: float | None = None,
    ) -> Metric:
        """now 는 점프 가드가 쓰는 단조 시계다. 안 주면 time.monotonic() 을 쓴다."""
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
            log.warning("pulse.signal_error", source=self.source, error=str(exc))
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

        accepted = self._guard(bpm, time.monotonic() if now is None else now)
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
        need = self.gate - GATE_HYSTERESIS if self._emitting else self.gate + GATE_HYSTERESIS
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
            log.info("pulse.jump_released", source=self.source, bpm=round(bpm, 1))
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
            "pulse.hold",
            source=self.source,
            reason=reason,
            confidence=confidence,
            progress=progress,
        )
        return self._metric(None, confidence, state, progress)

    def _metric(
        self, value: float | None, confidence: float | None, state: State, progress: float
    ) -> Metric:
        return Metric(
            key="hr",
            value=value,
            unit="bpm",
            source=self.source,
            mode=self.mode,
            state=state,
            confidence=confidence,
            progress=round(progress, 3),
            ts=server_now(),
        )


# --------------------------------------------------------------------------- #
# 신호처리
# --------------------------------------------------------------------------- #
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
