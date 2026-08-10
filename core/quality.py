"""confidence 산출.

어댑터가 신호에서 뽑은 관측치를 0~1 신뢰도 하나로 합친다. 이 값이 기준에 못
미치면 어댑터는 값을 내보내지 않고 보류한다 (README §0-4).

가중치와 정규화 상수는 여기 상수로 둔다. 운영자가 조정하는 임계값이 아니라
신호처리 알고리즘의 일부라서다. 반대로 "얼마부터 믿을 것인가"(confidence_min)는
운영 정책이므로 core.thresholds 가 thresholds.yaml 에서 읽는다 (README §10).

두 경로가 잠시 공존한다.
  - score()       가시광 rPPG 전용. 옥시미터 대비 정확도표가 이 공식으로 나왔다.
  - score_signal() 센서 중립. 입력이 "전처리된 1차원 시계열 + fs" 뿐이라 카메라
                   맥파든 열화상 콧구멍 온도든 같은 신호로 본다.
rPPG 를 아래쪽으로 이관하면 score() 는 사라진다. 이관에는 옥시미터 재측정이
따라야 한다 — 성분(배음비/2등피크/시간영역 일치)이 기록된 CSV 에 없어서 저장된
세션으로는 재현이 안 된다 (legacy/tieng_rppg/validation).

모달리티 고유 판정(밝기, 온도 대비, ROI 픽셀 수)은 여기 없다. 어댑터가 자기
게이트로 먼저 끝낸다 — 그 관문만 원시 센서 관측치를 봐야 하기 때문이다.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.signal import butter, detrend, find_peaks, sosfiltfilt

# SQI 가중 합. 합이 1.0 이어야 confidence 가 0~1 에 머문다.
W_SNR = 0.45
W_ENERGY = 0.30
W_ROI = 0.15
W_BRIGHTNESS = 0.10

SNR_MID_DB = 6.0  # q_snr = 0.5 가 되는 SNR
SNR_SLOPE_DB = 3.0
SKIN_RATIO_REF = 0.35  # 이만큼 잡히면 ROI 품질 만점
SKIN_RATIO_FLOOR = 0.10  # 이 아래면 ROI 가 얼굴을 놓친 것으로 본다
BRIGHTNESS_OK = (45.0, 220.0)  # 밖이면 절반으로 감점
BETA_MOTION = 0.7  # q_motion = 1 - BETA * jitter_norm


@dataclass(frozen=True)
class Quality:
    """confidence 와 그 성분. 성분을 함께 남겨야 왜 보류됐는지 추적할 수 있다."""

    confidence: float
    q_snr: float
    q_energy: float
    q_roi: float
    q_brightness: float
    q_motion: float

    def hold_reason(self) -> str:
        """confidence 가 낮을 때 어느 성분이 끌어내렸는지. README §8 디버깅용."""
        if self.q_motion < 0.6:
            return "motion/ROI jitter"
        if self.q_roi < 0.6:
            return "low ROI quality"
        if self.q_brightness < 1.0:
            return "lighting"
        if self.q_snr < 0.5 or self.q_energy < 0.5:
            return "low signal quality"
        return "low SQI"


def score(
    *,
    peak_snr_db: float,
    band_energy_ratio: float,
    skin_ratio: float,
    brightness: float,
    jitter_norm: float,
) -> Quality:
    q_snr = _sigmoid((peak_snr_db - SNR_MID_DB) / SNR_SLOPE_DB)
    q_energy = _clip(band_energy_ratio)
    q_roi = _clip(skin_ratio / SKIN_RATIO_REF)
    q_brightness = 1.0 if BRIGHTNESS_OK[0] <= brightness <= BRIGHTNESS_OK[1] else 0.5
    # 움직임은 가산이 아니라 곱으로 깎는다. 흔들리면 나머지가 아무리 좋아도 못 믿는다.
    q_motion = 1.0 - BETA_MOTION * _clip(jitter_norm)

    # 피부가 이만큼도 안 잡히면 얼굴을 놓친 것이므로 가중합에 맡기지 않는다.
    # q_roi 지분이 0.15 뿐이라, 얼굴이 나가도 잡음 스펙트럼의 SNR 이 높으면
    # 게이트를 통과해 엉뚱한 BPM 이 나간다 (실측에서 skin 2% 에 159bpm 관측).
    if skin_ratio < SKIN_RATIO_FLOOR:
        return Quality(0.0, q_snr, q_energy, q_roi, q_brightness, q_motion)

    confidence = _clip(
        (
            W_SNR * q_snr
            + W_ENERGY * q_energy
            + W_ROI * q_roi
            + W_BRIGHTNESS * q_brightness
        )
        * q_motion
    )
    return Quality(confidence, q_snr, q_energy, q_roi, q_brightness, q_motion)


def _clip(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    z = math.exp(x)
    return z / (1.0 + z)


# --------------------------------------------------------------------------- #
# 센서 중립 SQI
#
# 입력은 "전처리된 1차원 시계열 + fs" 뿐이다. 대역은 센서가 아니라 지표가 정한다 —
# 열화상으로 재든 카메라로 재든 호흡은 0.1~0.5Hz 다.
# --------------------------------------------------------------------------- #

# 가중 기하평균의 가중치. 합이 1 일 필요는 없다 (아래 combine 이 나눈다).
W_SQI = {
    "snr": 3.0,
    "harmonic": 1.0,
    "unambiguity": 2.0,
    "agreement": 1.5,
    "temporal": 1.5,
}

SNR_MID_DB_SQI = -3.0  # score_snr 이 0.5 가 되는 SNR
SNR_SLOPE_SQI = 0.55
HARMONIC_OK = (0.05, 0.60)  # 이 범위 밖이면 감점
HARMONIC_FLOOR = 0.15
SIG_HALFWIDTH_HZ = 0.10  # 주피크를 신호로 볼 폭
HARM_HALFWIDTH_HZ = 0.15  # 배음을 신호로 볼 폭
SECOND_PEAK_GUARD_HZ = 0.12  # 2등 피크를 찾을 때 주피크 주변을 이만큼 지운다


@dataclass(frozen=True)
class Band:
    """관심 지표의 주파수 대역 + 생리학적 제약."""

    name: str
    f_lo: float  # Hz
    f_hi: float  # Hz
    max_delta_per_sec: float  # 생리학적으로 가능한 최대 변화율 (bpm/s)
    min_window_sec: float  # 이보다 짧으면 주파수 분해능이 부족하다

    @property
    def bpm_hi(self) -> float:
        return self.f_hi * 60.0


BAND_HR = Band("HR", f_lo=0.70, f_hi=3.00, max_delta_per_sec=8.0, min_window_sec=8.0)
# 호흡은 저주파라 창이 길어야 한다. 20초는 최소선이고 rPPG 의 8초보다 훨씬 길어서,
# 화면의 progress 막대가 여기서 실제로 값어치를 한다 (README §2).
BAND_RR = Band("RR", f_lo=0.10, f_hi=0.50, max_delta_per_sec=2.0, min_window_sec=20.0)


@dataclass(frozen=True)
class Spectral:
    """대역 안에서 뽑은 추정값과 스펙트럼 품질 성분."""

    bpm: float
    snr_db: float  # 주피크+배음 대 대역 내 나머지
    harmonic_ratio: float  # P(2f)/P(f). 2f 가 대역 밖이면 nan = 측정 불가
    peak_ratio: float  # P(2등 피크)/P(주피크)


@dataclass(frozen=True)
class Sqi:
    """추정값 + confidence + 성분. 성분을 함께 남겨야 왜 보류됐는지 추적할 수 있다."""

    bpm: float
    confidence: float
    scores: dict[str, float]
    spectral: Spectral

    def hold_reason(self) -> str:
        """confidence 를 가장 많이 끌어내린 성분. 보류 사유 로그용 (README §8).

        화면으로 내보내지 않는다 — UI 문구를 신호처리 계층이 정하게 되기 때문이다.
        """
        if not self.scores:
            return "no scores"
        weakest = min(self.scores, key=lambda key: self.scores[key])
        return f"{weakest}={self.scores[weakest]:.2f}"


def score_signal(
    x: np.ndarray,
    fs: float,
    band: Band,
    *,
    bpm_prev: float | None = None,
    dt: float = 1.0,
) -> Sqi:
    """전처리된 신호에서 (추정값, confidence) 한 쌍을 낸다.

    bpm_prev/dt 는 시간적 일관성 성분에만 쓴다. 어댑터가 직전 값과 그 간격을
    들고 있다가 넘긴다 — 여기서 상태를 갖지 않는 이유는 같은 함수를 지표마다
    (HR, RR) 독립으로 불러야 하기 때문이다.
    """
    spectral = spectral_analysis(x, fs, band)
    bpm_td = time_domain_bpm(x, fs, band)
    tol = max(band.bpm_hi * 0.08, 2.0)

    scores = {
        "snr": score_snr(spectral.snr_db),
        "unambiguity": score_unambiguity(spectral.peak_ratio),
        "agreement": score_agreement(spectral.bpm, bpm_td, tol),
        "temporal": score_temporal(spectral.bpm, bpm_prev, dt, band),
    }
    # 배음비를 잴 수 없으면 키를 넣지 않는다. combine 이 가중치 합에서도 뺀다.
    if math.isfinite(spectral.harmonic_ratio):
        scores["harmonic"] = score_harmonic(spectral.harmonic_ratio)

    return Sqi(spectral.bpm, combine(scores), scores, spectral)


def spectral_analysis(x: np.ndarray, fs: float, band: Band) -> Spectral:
    freqs, psd = _psd(x, fs)
    in_band = (freqs >= band.f_lo) & (freqs <= band.f_hi)
    if not bool(np.any(in_band)):
        # 대역이 격자에 하나도 안 걸린다. 창이 너무 짧거나 fs 가 너무 낮다.
        return Spectral(float("nan"), -99.0, float("nan"), 1.0)

    band_psd = np.where(in_band, psd, 0.0)
    peak_idx = int(np.argmax(band_psd))
    f_peak = _peak_freq(freqs, psd, peak_idx)
    df = float(freqs[1] - freqs[0])

    def around(f0: float, halfwidth: float) -> np.ndarray:
        return (freqs >= f0 - halfwidth) & (freqs <= f0 + halfwidth)

    signal = around(f_peak, SIG_HALFWIDTH_HZ) | around(2.0 * f_peak, HARM_HALFWIDTH_HZ)
    p_sig = float(np.sum(psd[signal & in_band]) * df)
    p_band = float(np.sum(psd[in_band]) * df)
    snr_db = 10.0 * math.log10(max(p_sig, 1e-20) / max(p_band - p_sig, 1e-20))

    # 배음 일관성: 진짜 맥파는 2f 에 에너지가 있고 백색잡음은 없다.
    #
    # 단 2f 가 대역 밖이면 앞단 대역통과가 이미 지워 버린 뒤다. 남은 잔재로 비율을
    # 재면 신호 품질이 아니라 필터 감쇠를 재게 되고, 부호까지 뒤집힌다 — 잡음이
    # 2f 부근에 에너지를 넣어 더러운 신호가 더 높은 점수를 받는다. 측정 불가로 둔다.
    # RR 대역(0.1~0.5Hz)에서는 12rpm 이상이면 전부 여기 해당한다.
    if 2.0 * f_peak + SIG_HALFWIDTH_HZ <= band.f_hi:
        p_fund = float(np.sum(psd[around(f_peak, SIG_HALFWIDTH_HZ)]) * df)
        p_harm = float(np.sum(psd[around(2.0 * f_peak, SIG_HALFWIDTH_HZ)]) * df)
        harmonic_ratio = p_harm / max(p_fund, 1e-20)
    else:
        harmonic_ratio = float("nan")

    # 피크 모호성: 2등 피크가 주피크에 가까우면 FFT 가 헷갈리고 있다는 뜻이다.
    masked = band_psd.copy()
    masked[around(f_peak, SECOND_PEAK_GUARD_HZ)] = 0.0
    second = float(np.max(masked)) if bool(np.any(masked > 0)) else 0.0
    peak_ratio = second / max(float(band_psd[peak_idx]), 1e-20)

    return Spectral(f_peak * 60.0, snr_db, harmonic_ratio, peak_ratio)


def time_domain_bpm(x: np.ndarray, fs: float, band: Band) -> float:
    """시간영역 피크 검출로 독립적인 2차 추정값을 만든다.

    표시용이 아니다. FFT 와 원리가 달라서, 둘이 같은 답을 내면 그 일치 자체가
    품질의 증거가 된다 (score_agreement).
    """
    detrended = detrend(np.asarray(x, dtype=np.float64), type="linear")
    sos = butter(3, [band.f_lo, band.f_hi], btype="band", fs=fs, output="sos")
    filtered = sosfiltfilt(sos, detrended)
    spread = float(np.std(filtered))
    if spread < 1e-12:
        return float("nan")
    peaks, _ = find_peaks(
        filtered,
        distance=max(int(fs / band.f_hi * 0.7), 1),
        prominence=spread * 0.4,
    )
    if len(peaks) < 3:
        return float("nan")
    interval = float(np.median(np.diff(peaks) / fs))
    return 60.0 / interval if interval > 0 else float("nan")


def score_snr(snr_db: float) -> float:
    return _sigmoid(SNR_SLOPE_SQI * (snr_db - SNR_MID_DB_SQI))


def score_harmonic(ratio: float) -> float:
    """배음비가 0.05~0.6 이면 생리학적으로 그럴듯하다. 너무 크면 주파수 오검출이다.

    2f 가 대역 밖이라 잴 수 없을 때는 이 함수를 부르지 않는다. '해당 없음' 은
    점수가 아니라 키의 부재로 표현한다 (combine 참고).
    """
    if ratio <= 0:
        return HARMONIC_FLOOR
    lo, hi = HARMONIC_OK
    if ratio < lo:
        return HARMONIC_FLOOR + (1.0 - HARMONIC_FLOOR) * (ratio / lo)
    if ratio <= hi:
        return 1.0
    return max(HARMONIC_FLOOR, 1.0 - (ratio - hi) / 1.5)


def score_unambiguity(peak_ratio: float) -> float:
    """2등 피크가 낮을수록 확신이 높다."""
    return math.pow(_clip(1.0 - peak_ratio), 0.7)


def score_agreement(bpm_fft: float, bpm_td: float, tol: float) -> float:
    if not math.isfinite(bpm_fft) or not math.isfinite(bpm_td):
        return 0.5  # 한쪽을 못 구했다. 가점도 벌점도 주지 않는다.
    return math.exp(-((abs(bpm_fft - bpm_td) / tol) ** 2))


def score_temporal(bpm_now: float, bpm_prev: float | None, dt: float, band: Band) -> float:
    """생리학적으로 불가능한 점프를 벌한다.

    심박이 2초 만에 30bpm 뛰는 일은 없다. 그런 값은 FFT 가 움직임 배음에 잘못
    락온한 것이다 — rPPG 의 대표적 실패 모드.
    """
    if bpm_prev is None or not math.isfinite(bpm_prev) or not math.isfinite(bpm_now):
        return 0.7  # 첫 측정. 중립보다 약간 낮게 시작한다.
    allowed = band.max_delta_per_sec * max(dt, 1e-3)
    return math.exp(-0.5 * ((abs(bpm_now - bpm_prev) / max(allowed, 1e-6)) ** 2))


def combine(scores: dict[str, float]) -> float:
    """가중 기하평균.

    산술평균은 "SNR 은 최악인데 나머지가 좋아서 통과" 를 허용한다. 기하평균은 한
    성분이라도 0 에 가까우면 전체가 0 이 되므로 그 사고를 구조적으로 막는다.

    없는 키는 '측정 불가' 로 보고 가중치 합에서도 뺀다. 기본값 0.5 를 채우면
    '해당 없음' 과 '품질이 그저 그럼' 이 같아져서, 잴 수 없는 성분 때문에
    confidence 가 깎인다.
    """
    numerator = 0.0
    denominator = 0.0
    for key, weight in W_SQI.items():
        if key not in scores:
            continue
        numerator += weight * math.log(max(_clip(scores[key]), 1e-6))
        denominator += weight
    return math.exp(numerator / denominator) if denominator > 0 else 0.0


def _psd(x: np.ndarray, fs: float, pad_factor: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Hann 창 + zero-padding FFT.

    zero-padding 은 피크 '위치' 추정을 정밀하게 할 뿐, 가까운 두 성분을 분리하는
    분해능(Δf ≈ 1/T)은 높이지 못한다. 창 길이를 줄이는 근거로 쓰면 안 된다.
    """
    detrended = detrend(np.asarray(x, dtype=np.float64), type="linear")
    window = np.hanning(len(detrended))
    nfft = int(2 ** math.ceil(math.log2(max(len(detrended) * pad_factor, 2))))
    spec = np.fft.rfft(detrended * window, n=nfft)
    psd = (np.abs(spec) ** 2) / (float(np.sum(window**2)) * fs)
    return np.fft.rfftfreq(nfft, d=1.0 / fs), psd


def _peak_freq(freqs: np.ndarray, psd: np.ndarray, index: int) -> float:
    """포물선 보간. bin 해상도보다 잘게 피크 주파수를 잡는다."""
    if index <= 0 or index >= len(psd) - 1:
        return float(freqs[index])
    left, center, right = float(psd[index - 1]), float(psd[index]), float(psd[index + 1])
    denom = left - 2.0 * center + right
    if abs(denom) < 1e-20:
        return float(freqs[index])
    delta = float(np.clip(0.5 * (left - right) / denom, -1.0, 1.0))
    return float(freqs[index]) + delta * float(freqs[1] - freqs[0])
