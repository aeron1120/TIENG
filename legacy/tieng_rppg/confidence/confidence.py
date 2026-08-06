"""
TouchFree Vitals — confidence (신호 품질) 모듈  v3

설계 원칙
---------
1. 센서 중립: 입력은 "1차원 시계열 + fps"일 뿐이다. POS rPPG 맥파든, 상체 움직임
   신호든, 나중에 붙을 열화상 콧구멍 온도든 동일한 인터페이스로 처리한다.
   새 센서를 추가한다 == (추정값, 신뢰도) 한 쌍을 더 넣는다.
2. 4층 구조: 전제조건 게이트 → 신호품질지수(SQI) → 시간적 일관성 → 캘리브레이션
3. "왜 나쁜지"를 보존한다. 실패는 항상 사유 코드(GateReason)와 함께 반환된다.
4. confidence 값의 계산과, 그 값으로 무엇을 할지(표시/보류/알림)는 분리한다.

사용 예
-------
    est = VitalEstimator(BAND_HR, fps=30.0)
    r   = est.update(signal_window, ctx)      # ctx: 게이트용 프레임 컨텍스트
    if r.ok:
        print(r.bpm, r.confidence, r.expected_mae)

Author: TouchFree Vitals team
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, Sequence

import numpy as np
from scipy import signal as sps


# ---------------------------------------------------------------------------
# 대역 정의
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Band:
    """관심 생체신호의 주파수 대역 + 생리학적 제약."""
    name: str
    f_lo: float               # Hz
    f_hi: float               # Hz
    max_delta_per_sec: float  # bpm/s — 생리학적으로 가능한 최대 변화율
    min_window_sec: float     # 이 길이 미만이면 주파수 분해능 부족

    @property
    def bpm_lo(self) -> float:
        return self.f_lo * 60.0

    @property
    def bpm_hi(self) -> float:
        return self.f_hi * 60.0


# 심박: 42~180 bpm. 10초 윈도우면 분해능 6bpm이지만 zero-padding+보간으로 보완.
BAND_HR = Band("HR", f_lo=0.70, f_hi=3.00, max_delta_per_sec=8.0, min_window_sec=8.0)

# 호흡: 6~30 bpm. 저주파라 윈도우가 길어야 한다. 20초는 최소선.
BAND_RR = Band("RR", f_lo=0.10, f_hi=0.50, max_delta_per_sec=2.0, min_window_sec=20.0)


# ---------------------------------------------------------------------------
# 1층: 전제조건 게이트
# ---------------------------------------------------------------------------

class GateReason(str, Enum):
    """측정을 보류하는 사유. 사용자 메시지와 로그 분석 양쪽에 쓰인다."""
    OK              = "ok"
    NO_ROI          = "roi_missing"        # 얼굴/상체 검출 실패
    TOO_DARK        = "underexposed"       # ROI 과소노출
    TOO_BRIGHT      = "overexposed"        # ROI 포화 (창가 역광 등)
    MOTION          = "excessive_motion"   # 전역 움직임 과다
    WARMING_UP      = "insufficient_data"  # 윈도우 미충족
    UNSTABLE_FPS    = "unstable_fps"       # 프레임 간격 지터 과다
    FLAT_SIGNAL     = "flat_signal"        # 분산 거의 0 (정지영상/렌즈 가림)

    @property
    def message_ko(self) -> str:
        return {
            "ok":                "정상",
            "roi_missing":       "얼굴이 보이지 않습니다",
            "underexposed":      "주변이 너무 어둡습니다",
            "overexposed":       "빛이 너무 강합니다 (역광 확인)",
            "excessive_motion":  "움직임이 많습니다",
            "insufficient_data": "측정 준비 중입니다",
            "unstable_fps":      "카메라 프레임이 불안정합니다",
            "flat_signal":       "신호가 잡히지 않습니다",
        }[self.value]


@dataclass
class FrameContext:
    """게이트 판정에 필요한 프레임 단위 관측치.

    영상 파이프라인이 채워서 넘겨준다. confidence 모듈은 영상을 직접 보지 않는다.
    """
    roi_found: bool = True
    roi_mean_intensity: float = 128.0   # 0-255, ROI 평균 밝기
    roi_saturated_frac: float = 0.0     # 포화(>=250) 픽셀 비율 0-1
    roi_dark_frac: float = 0.0          # 과소(<=5) 픽셀 비율 0-1
    motion_magnitude: float = 0.0       # ROI 변위 크기 (픽셀/프레임)
    fps_jitter: float = 0.0             # 프레임 간격 표준편차 / 평균

    # --- 임계값 (캘리브레이션으로 조정 가능) ---
    T_DARK_MEAN      = 35.0
    T_BRIGHT_MEAN    = 235.0
    T_SATURATED_FRAC = 0.20
    T_DARK_FRAC      = 0.40
    T_MOTION         = 4.0
    T_FPS_JITTER     = 0.35


def gate_check(ctx: FrameContext, n_samples: int, fps: float, band: Band) -> GateReason:
    """1층. 계산을 시작할 가치가 있는지 판정한다. 싸고 해석 가능한 것부터."""
    if not ctx.roi_found:
        return GateReason.NO_ROI

    need = int(band.min_window_sec * fps)
    if n_samples < need:
        return GateReason.WARMING_UP

    if ctx.fps_jitter > FrameContext.T_FPS_JITTER:
        return GateReason.UNSTABLE_FPS

    if (ctx.roi_mean_intensity < FrameContext.T_DARK_MEAN
            or ctx.roi_dark_frac > FrameContext.T_DARK_FRAC):
        return GateReason.TOO_DARK

    if (ctx.roi_mean_intensity > FrameContext.T_BRIGHT_MEAN
            or ctx.roi_saturated_frac > FrameContext.T_SATURATED_FRAC):
        return GateReason.TOO_BRIGHT

    if ctx.motion_magnitude > FrameContext.T_MOTION:
        return GateReason.MOTION

    return GateReason.OK


# ---------------------------------------------------------------------------
# 2층: 신호품질지수 (SQI)
# ---------------------------------------------------------------------------

@dataclass
class SpectralResult:
    bpm: float
    snr_db: float           # 대역 내 주피크+배음 대 나머지
    harmonic_ratio: float   # P(2f) / P(f)
    peak_ratio: float       # P(2등 피크) / P(주피크)
    band_power_frac: float  # 대역 내 파워 / 전체 파워


def _welch_like_psd(x: np.ndarray, fps: float, pad_factor: int = 8):
    """Hann 창 + zero-padding FFT. v2 데모의 방식과 동일 계열."""
    x = np.asarray(x, dtype=float)
    x = sps.detrend(x, type="linear")
    w = np.hanning(len(x))
    xw = x * w
    nfft = int(2 ** math.ceil(math.log2(len(xw) * pad_factor)))
    spec = np.fft.rfft(xw, n=nfft)
    psd = (np.abs(spec) ** 2) / (np.sum(w ** 2) * fps)
    freqs = np.fft.rfftfreq(nfft, d=1.0 / fps)
    return freqs, psd


def _parabolic_peak(freqs: np.ndarray, psd: np.ndarray, idx: int) -> float:
    """포물선 보간으로 피크 주파수를 서브빈 정밀도로 추정."""
    if idx <= 0 or idx >= len(psd) - 1:
        return float(freqs[idx])
    a, b, c = psd[idx - 1], psd[idx], psd[idx + 1]
    denom = a - 2 * b + c
    if abs(denom) < 1e-20:
        return float(freqs[idx])
    delta = 0.5 * (a - c) / denom
    delta = float(np.clip(delta, -1.0, 1.0))
    df = freqs[1] - freqs[0]
    return float(freqs[idx] + delta * df)


def spectral_analysis(x: np.ndarray, fps: float, band: Band) -> SpectralResult:
    """주파수 영역에서 추정값과 품질 성분을 함께 뽑는다."""
    freqs, psd = _welch_like_psd(x, fps)

    in_band = (freqs >= band.f_lo) & (freqs <= band.f_hi)
    if not np.any(in_band):
        return SpectralResult(float("nan"), -99.0, 0.0, 1.0, 0.0)

    band_psd = np.where(in_band, psd, 0.0)
    peak_idx = int(np.argmax(band_psd))
    f_peak = _parabolic_peak(freqs, psd, peak_idx)
    bpm = f_peak * 60.0

    df = freqs[1] - freqs[0]
    # 신호로 간주할 폭: 주피크 ±0.1Hz, 배음 ±0.15Hz
    def _mask_around(f0, halfwidth):
        return (freqs >= f0 - halfwidth) & (freqs <= f0 + halfwidth)

    sig_mask = _mask_around(f_peak, 0.10) | _mask_around(2 * f_peak, 0.15)
    p_sig = float(np.sum(psd[sig_mask & in_band]) * df)
    p_band = float(np.sum(psd[in_band]) * df)
    p_noise = max(p_band - p_sig, 1e-20)
    snr_db = 10.0 * math.log10(max(p_sig, 1e-20) / p_noise)

    # 배음 일관성: 진짜 맥파는 2f에 에너지가 있고, 백색잡음은 없다.
    harm_mask = _mask_around(2 * f_peak, 0.10)
    p_harm = float(np.sum(psd[harm_mask]) * df)
    p_fund = float(np.sum(psd[_mask_around(f_peak, 0.10)]) * df)
    harmonic_ratio = p_harm / max(p_fund, 1e-20)

    # 피크 모호성: 2등 피크가 주피크에 가까우면 FFT가 헷갈리고 있다는 뜻.
    masked = band_psd.copy()
    masked[_mask_around(f_peak, 0.12)] = 0.0
    second = float(np.max(masked)) if np.any(masked > 0) else 0.0
    peak_ratio = second / max(float(band_psd[peak_idx]), 1e-20)

    total_power = float(np.sum(psd) * df)
    band_power_frac = p_band / max(total_power, 1e-20)

    return SpectralResult(bpm, snr_db, harmonic_ratio, peak_ratio, band_power_frac)


def time_domain_bpm(x: np.ndarray, fps: float, band: Band) -> float:
    """시간영역 피크 검출로 독립적인 2차 추정값을 만든다.

    FFT보다 급변에 빠르게 반응한다. FFT 결과와의 일치도 자체를 품질 지표로 쓴다.
    """
    x = sps.detrend(np.asarray(x, dtype=float), type="linear")
    sos = sps.butter(3, [band.f_lo, band.f_hi], btype="band", fs=fps, output="sos")
    xf = sps.sosfiltfilt(sos, x)
    min_dist = max(int(fps / band.f_hi * 0.7), 1)
    peaks, _ = sps.find_peaks(xf, distance=min_dist, prominence=np.std(xf) * 0.4)
    if len(peaks) < 3:
        return float("nan")
    intervals = np.diff(peaks) / fps
    med = float(np.median(intervals))
    if med <= 0:
        return float("nan")
    return 60.0 / med


# --- 개별 성분을 0~1 점수로 사상 ---------------------------------------------

def _logistic(x: float, x0: float, k: float) -> float:
    return 1.0 / (1.0 + math.exp(-k * (x - x0)))


def score_snr(snr_db: float) -> float:
    """SNR -3dB 부근을 반환점으로. 경험적이지만 캘리브레이션으로 검증된다."""
    return _logistic(snr_db, x0=-3.0, k=0.55)


def score_harmonic(ratio: float) -> float:
    """배음비가 0.05~0.6이면 생리학적으로 그럴듯하다. 너무 크면 주파수 오검출."""
    if ratio <= 0:
        return 0.15
    lo, hi = 0.05, 0.60
    if lo <= ratio <= hi:
        return 1.0
    if ratio < lo:
        return 0.15 + 0.85 * (ratio / lo)
    return max(0.15, 1.0 - (ratio - hi) / 1.5)


def score_unambiguity(peak_ratio: float) -> float:
    """2등 피크가 낮을수록 확신이 높다."""
    return float(np.clip(1.0 - peak_ratio, 0.0, 1.0)) ** 0.7


def score_agreement(bpm_fft: float, bpm_td: float, tol: float) -> float:
    """FFT 추정과 시간영역 추정의 일치도. 원리가 다른 둘이 같은 답이면 강한 증거."""
    if not np.isfinite(bpm_fft) or not np.isfinite(bpm_td):
        return 0.5   # 판단 보류 — 벌점도 가점도 주지 않음
    d = abs(bpm_fft - bpm_td)
    return float(math.exp(-(d / tol) ** 2))


# ---------------------------------------------------------------------------
# 3층: 시간적 일관성
# ---------------------------------------------------------------------------

def score_temporal(bpm_now: float, bpm_prev: Optional[float],
                   dt: float, band: Band) -> float:
    """생리학적으로 불가능한 점프를 벌한다.

    심박이 2초 만에 30bpm 뛰는 일은 없다. 그런 값은 FFT가 움직임 배음에
    잘못 락온한 것이다 — rPPG의 대표적 실패 모드.
    """
    if bpm_prev is None or not np.isfinite(bpm_prev):
        return 0.7   # 첫 측정: 중립보다 약간 낮게 시작
    allowed = band.max_delta_per_sec * max(dt, 1e-3)
    d = abs(bpm_now - bpm_prev)
    return float(math.exp(-0.5 * (d / max(allowed, 1e-6)) ** 2))


# ---------------------------------------------------------------------------
# 종합
# ---------------------------------------------------------------------------

# 가중 기하평균을 쓴다. 한 성분이라도 0에 가까우면 전체가 0이 되어야 하기 때문.
# 산술평균은 "SNR은 최악인데 나머지가 좋아서 통과" 같은 사고를 허용한다.
WEIGHTS = {
    "snr":          3.0,
    "harmonic":     1.0,
    "unambiguity":  2.0,
    "agreement":    1.5,
    "temporal":     1.5,
}


def combine(scores: dict) -> float:
    num = 0.0
    den = 0.0
    for k, w in WEIGHTS.items():
        s = float(np.clip(scores.get(k, 0.5), 1e-6, 1.0))
        num += w * math.log(s)
        den += w
    return float(math.exp(num / den))


@dataclass
class VitalReading:
    """한 번의 측정 결과. 성공이든 실패든 항상 이 형태로 반환된다."""
    band: str
    ok: bool
    reason: GateReason
    bpm: float = float("nan")
    bpm_td: float = float("nan")
    confidence: float = 0.0
    expected_mae: Optional[float] = None   # 캘리브레이션 있을 때만
    scores: dict = field(default_factory=dict)
    spectral: Optional[dict] = None

    def to_row(self) -> dict:
        d = asdict(self)
        d["reason"] = self.reason.value
        d.pop("spectral", None)
        d.pop("scores", None)
        return d


class VitalEstimator:
    """4층 구조를 묶어 하나의 vital sign을 추정한다.

    vital마다 인스턴스를 따로 둔다 — 말하는 중이면 RR만 망가지고 HR은 멀쩡한
    상황을 표현하려면 confidence가 vital별로 독립이어야 한다.
    """

    def __init__(self, band: Band, fps: float,
                 calibration: "Calibration | None" = None):
        self.band = band
        self.fps = fps
        self.calibration = calibration
        self._prev_bpm: Optional[float] = None
        self._prev_t: Optional[float] = None

    def update(self, window: Sequence[float], ctx: FrameContext,
               t_now: Optional[float] = None) -> VitalReading:
        x = np.asarray(window, dtype=float)

        reason = gate_check(ctx, len(x), self.fps, self.band)
        if reason is not GateReason.OK:
            return VitalReading(self.band.name, False, reason)

        if float(np.std(x)) < 1e-9:
            return VitalReading(self.band.name, False, GateReason.FLAT_SIGNAL)

        sr = spectral_analysis(x, self.fps, self.band)
        bpm_td = time_domain_bpm(x, self.fps, self.band)

        dt = 1.0 if (t_now is None or self._prev_t is None) else max(t_now - self._prev_t, 1e-3)
        tol = max(self.band.bpm_hi * 0.08, 2.0)

        scores = {
            "snr":         score_snr(sr.snr_db),
            "harmonic":    score_harmonic(sr.harmonic_ratio),
            "unambiguity": score_unambiguity(sr.peak_ratio),
            "agreement":   score_agreement(sr.bpm, bpm_td, tol),
            "temporal":    score_temporal(sr.bpm, self._prev_bpm, dt, self.band),
        }
        conf = combine(scores)

        self._prev_bpm = sr.bpm
        self._prev_t = t_now if t_now is not None else (self._prev_t or 0.0) + 1.0

        mae = self.calibration.expected_mae(conf) if self.calibration else None

        return VitalReading(
            band=self.band.name, ok=True, reason=GateReason.OK,
            bpm=sr.bpm, bpm_td=bpm_td, confidence=conf,
            expected_mae=mae, scores=scores, spectral=asdict(sr),
        )


# ---------------------------------------------------------------------------
# 4층: 캘리브레이션 — confidence를 실제 오차(bpm)로 사상
# ---------------------------------------------------------------------------

def _isotonic_decreasing(y: np.ndarray, w: np.ndarray | None = None) -> np.ndarray:
    """가중 등위회귀 (단조 비증가). scipy>=1.12 우선, 없으면 PAVA 직접 구현."""
    y = np.asarray(y, float)
    w = np.ones_like(y) if w is None else np.asarray(w, float)
    try:
        from scipy.optimize import isotonic_regression
        return np.asarray(isotonic_regression(y, weights=w, increasing=False).x, float)
    except Exception:
        pass
    # PAVA (pool adjacent violators) — 비증가 제약
    vals = list(y)
    wts = list(w)
    lens = [1] * len(y)
    i = 0
    while i < len(vals) - 1:
        if vals[i] < vals[i + 1] - 1e-12:          # 위반: 뒤가 더 크다
            tw = wts[i] + wts[i + 1]
            vals[i] = (vals[i] * wts[i] + vals[i + 1] * wts[i + 1]) / tw
            wts[i] = tw
            lens[i] += lens[i + 1]
            del vals[i + 1], wts[i + 1], lens[i + 1]
            i = max(i - 1, 0)
        else:
            i += 1
    out = []
    for v, L in zip(vals, lens):
        out.extend([v] * L)
    return np.array(out, float)


class Calibration:
    """confidence → 기대 오차(bpm) 매핑.

    '0.7'이라는 값에 물리적 의미를 준다. 임계값을 눈대중이 아니라
    목표 오차로부터 역산할 수 있게 하는 것이 이 클래스의 존재 이유.
    """

    def __init__(self, edges: np.ndarray, maes: np.ndarray, counts: np.ndarray):
        self.edges = np.asarray(edges, float)
        self.maes = np.asarray(maes, float)
        self.counts = np.asarray(counts, int)

    # --- 학습 ---
    @classmethod
    def fit(cls, confidences, errors, n_bins: int = 10, min_count: int = 5) -> "Calibration":
        c = np.asarray(confidences, float)
        e = np.abs(np.asarray(errors, float))
        ok = np.isfinite(c) & np.isfinite(e)
        c, e = c[ok], e[ok]

        edges = np.linspace(0.0, 1.0, n_bins + 1)
        maes, counts = [], []
        for i in range(n_bins):
            m = (c >= edges[i]) & (c < edges[i + 1] if i < n_bins - 1 else c <= edges[i + 1])
            counts.append(int(m.sum()))
            maes.append(float(np.mean(e[m])) if m.sum() >= min_count else np.nan)

        maes = np.array(maes, float)
        counts = np.array(counts, int)

        # 표본 부족 구간은 이웃에서 보간한 뒤, 등위회귀(isotonic regression)로
        # 단조 감소를 강제한다. "신뢰도가 높을수록 오차가 작다"는 것은 물리적
        # 제약이므로, 표본 잡음으로 뒤집힌 구간은 최소제곱 의미에서 펴 준다.
        #
        # 주의: 단순히 누적최소(np.minimum.accumulate)를 쓰면 안 된다. 그러면
        # 모든 구간이 전역 최소값으로 뭉개져서 캘리브레이션이 무의미해진다.
        idx = np.arange(n_bins)
        good = np.isfinite(maes)
        if good.sum() >= 2:
            maes = np.interp(idx, idx[good], maes[good])
            w = np.maximum(counts, 1).astype(float)   # 표본 많은 구간에 더 무게
            maes = _isotonic_decreasing(maes, w)
        else:
            maes = np.full(n_bins, np.nan)
        return cls(edges, maes, counts)

    # --- 사용 ---
    def expected_mae(self, conf: float) -> float:
        if not np.isfinite(self.maes).any():
            return float("nan")
        centers = 0.5 * (self.edges[:-1] + self.edges[1:])
        return float(np.interp(np.clip(conf, 0, 1), centers, self.maes))

    def threshold_for_mae(self, target_mae: float) -> float:
        """목표 오차를 만족하는 최소 confidence. 임계값 역산의 핵심."""
        centers = 0.5 * (self.edges[:-1] + self.edges[1:])
        ok = np.isfinite(self.maes) & (self.maes <= target_mae)
        if not ok.any():
            return 1.0     # 어떤 구간도 목표를 못 맞춤 → 사실상 전부 보류
        return float(centers[np.argmax(ok)])

    def coverage_curve(self, confidences, errors, n: int = 40):
        """보류율 vs MAE 곡선. 발표의 핵심 그래프."""
        c = np.asarray(confidences, float)
        e = np.abs(np.asarray(errors, float))
        ths = np.linspace(0.0, 0.95, n)
        out = []
        for t in ths:
            keep = c >= t
            if keep.sum() == 0:
                continue
            out.append((t, 1.0 - keep.mean(), float(np.mean(e[keep])), int(keep.sum())))
        return out  # (threshold, hold_rate, mae, n_kept)

    # --- 직렬화 ---
    def save(self, path: str) -> None:
        with open(path, "w") as f:
            json.dump({"edges": self.edges.tolist(),
                       "maes": [None if not np.isfinite(v) else v for v in self.maes],
                       "counts": self.counts.tolist()}, f, indent=2)

    @classmethod
    def load(cls, path: str) -> "Calibration":
        with open(path) as f:
            d = json.load(f)
        maes = np.array([np.nan if v is None else v for v in d["maes"]], float)
        return cls(np.array(d["edges"], float), maes, np.array(d["counts"], int))


# ---------------------------------------------------------------------------
# 판정 정책 — confidence 값과 분리된 계층
# ---------------------------------------------------------------------------

class DisplayState(str, Enum):
    EXACT   = "exact"     # 정확값 표시
    RANGE   = "range"     # 범위로 표시
    TREND   = "trend"     # 추세만, 숫자 숨김
    HOLD    = "hold"      # 보류

    @property
    def label_ko(self) -> str:
        return {"exact": "측정됨", "range": "대략",
                "trend": "추세만", "hold": "측정 보류"}[self.value]


@dataclass
class DisplayDecision:
    state: DisplayState
    text: str
    bpm: Optional[float] = None
    half_width: Optional[float] = None
    reason: Optional[GateReason] = None


class DecisionPolicy:
    """히스테리시스 + 단계적 강등.

    임계값 하나로 자르면 경계에서 표시/보류가 매 윈도우 깜빡인다. 데모에서
    이러면 고장난 것처럼 보인다. 진입/이탈 임계값을 분리해 관성을 준다.
    """

    def __init__(self, t_exact=0.75, t_range=0.55, t_trend=0.40, hysteresis=0.08):
        self.t = {DisplayState.EXACT: t_exact,
                  DisplayState.RANGE: t_range,
                  DisplayState.TREND: t_trend}
        self.h = hysteresis
        self.state = DisplayState.HOLD

    @classmethod
    def from_calibration(cls, cal: Calibration, mae_exact: float, mae_range: float,
                         mae_trend: float, hysteresis: float = 0.08) -> "DecisionPolicy":
        """목표 오차로부터 임계값을 역산. 눈대중 임계값을 없애는 경로."""
        return cls(t_exact=cal.threshold_for_mae(mae_exact),
                   t_range=cal.threshold_for_mae(mae_range),
                   t_trend=cal.threshold_for_mae(mae_trend),
                   hysteresis=hysteresis)

    def _target(self, conf: float) -> DisplayState:
        # 현재 상태보다 높은 등급으로 올라가려면 +h 를 더 넘어야 한다(히스테리시스)
        order = [DisplayState.EXACT, DisplayState.RANGE, DisplayState.TREND]
        rank = {s: i for i, s in enumerate(order + [DisplayState.HOLD])}
        for s in order:
            need = self.t[s]
            if rank[s] < rank[self.state]:      # 등급 상승 시도
                need += self.h
            if conf >= need:
                return s
        return DisplayState.HOLD

    def decide(self, r: VitalReading) -> DisplayDecision:
        if not r.ok:
            self.state = DisplayState.HOLD
            return DisplayDecision(DisplayState.HOLD, r.reason.message_ko, reason=r.reason)

        self.state = self._target(r.confidence)
        hw = r.expected_mae if (r.expected_mae and np.isfinite(r.expected_mae)) else 5.0

        if self.state is DisplayState.EXACT:
            return DisplayDecision(self.state, f"{r.bpm:.0f}", r.bpm)
        if self.state is DisplayState.RANGE:
            return DisplayDecision(self.state, f"{r.bpm - hw:.0f}–{r.bpm + hw:.0f}", r.bpm, hw)
        if self.state is DisplayState.TREND:
            return DisplayDecision(self.state, "추세만 표시", r.bpm)
        return DisplayDecision(DisplayState.HOLD, "신호 품질 낮음", reason=None)


# ---------------------------------------------------------------------------
# 알림 정책 — 표시보다 훨씬 엄격하게
# ---------------------------------------------------------------------------

class AlertKind(str, Enum):
    NONE          = "none"
    ABNORMAL      = "abnormal"        # 값이 이상 범위
    SIGNAL_LOST   = "signal_lost"     # 장시간 측정 불가 = 그 자체로 이벤트


@dataclass
class Alert:
    kind: AlertKind
    detail: str


class AlertPolicy:
    """새벽 3시 오탐은 실제 피해다. 알림은 표시보다 훨씬 보수적으로 낸다.

    - 이상 알림: '고신뢰' 윈도우가 N개 연속으로 이상 범위일 때만
    - 소실 알림: 보류가 오래 지속되는 것 자체를 보고 (외출/전도 가능성)
    """

    def __init__(self, lo: float, hi: float, min_conf: float = 0.75,
                 n_consecutive: int = 5, hold_seconds: float = 1800.0):
        self.lo, self.hi = lo, hi
        self.min_conf = min_conf
        self.n_consecutive = n_consecutive
        self.hold_seconds = hold_seconds
        self._streak = 0
        self._hold_since: Optional[float] = None
        self._fired_lost = False

    def update(self, r: VitalReading, t_now: float) -> Alert:
        # --- 신호 소실 추적 ---
        usable = r.ok and r.confidence >= self.min_conf
        if usable:
            self._hold_since = None
            self._fired_lost = False
        else:
            if self._hold_since is None:
                self._hold_since = t_now
            elif (t_now - self._hold_since) >= self.hold_seconds and not self._fired_lost:
                self._fired_lost = True
                mins = (t_now - self._hold_since) / 60.0
                return Alert(AlertKind.SIGNAL_LOST,
                             f"{mins:.0f}분간 측정 불가 — 재실 여부 확인 필요")

        # --- 이상값 추적 (고신뢰 윈도우만 카운트) ---
        if not usable:
            return Alert(AlertKind.NONE, "")
        if r.bpm < self.lo or r.bpm > self.hi:
            self._streak += 1
            if self._streak >= self.n_consecutive:
                self._streak = 0
                return Alert(AlertKind.ABNORMAL,
                             f"{r.band} {r.bpm:.0f} (정상범위 {self.lo:.0f}–{self.hi:.0f})")
        else:
            self._streak = 0
        return Alert(AlertKind.NONE, "")


# ---------------------------------------------------------------------------
# 융합 — 새 센서를 붙이는 지점
# ---------------------------------------------------------------------------

def fuse(readings: Sequence[VitalReading], min_conf: float = 0.35):
    """분산 역수 가중 융합. 통계적으로 최적인 선형 결합.

    캘리브레이션이 있으면 w = 1/MAE^2, 없으면 confidence를 대리값으로 쓴다.
    열화상/NIR/레이더를 추가한다는 것은 이 리스트에 원소를 하나 더 넣는 것과
    같다 — 융합 로직 자체는 바뀌지 않는다. (석사논문의 품질지수 가중융합 구조)
    """
    usable = [r for r in readings if r.ok and r.confidence >= min_conf
              and np.isfinite(r.bpm)]
    if not usable:
        return float("nan"), 0.0

    ws, vs = [], []
    for r in usable:
        if r.expected_mae and np.isfinite(r.expected_mae) and r.expected_mae > 0:
            w = 1.0 / (r.expected_mae ** 2)
        else:
            w = r.confidence ** 2
        ws.append(w)
        vs.append(r.bpm)

    ws = np.array(ws, float)
    vs = np.array(vs, float)
    bpm = float(np.sum(ws * vs) / np.sum(ws))

    # 융합 신뢰도: 독립 추정이 많을수록 오르되, 서로 어긋나면 깎는다.
    spread = float(np.std(vs)) if len(vs) > 1 else 0.0
    agree = math.exp(-(spread / 6.0) ** 2)
    base = 1.0 - float(np.prod([1.0 - r.confidence for r in usable]))
    return bpm, float(np.clip(base * agree, 0.0, 1.0))
