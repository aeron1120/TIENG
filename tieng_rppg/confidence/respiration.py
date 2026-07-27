"""
TouchFree Vitals — 호흡수(RR) 추정 골조  v0.1

이론 → 코드 대응
----------------
경로 A (기계적 변위)      : ChestMotionSource, LandmarkSource
경로 B (맥파 변조 복조)   : RIIVSource(기저선), RIAVSource(진폭), RIFVSource(박동간격)
주파수 추정 (교체 가능)   : FFTEstimator, AutocorrEstimator, BurgAREstimator, PeakCountEstimator
품질 판정 + 융합          : confidence.py 재사용 (VitalEstimator / fuse)

설계 원칙
---------
* Source 는 "프레임마다 스칼라 하나"를 만들어 (t, v) 로 쌓는다. 조밀 광류장을
  통째로 들고 다니지 않는다 — Pi 실시간성의 핵심.
* Source 와 Estimator 는 서로를 모른다. 새 신호원(열화상 콧구멍 온도 등)을
  추가하려면 Source 와 그 센서의 GateContext 만 구현하면 된다.
* 모든 Source 는 비균일 표본을 낼 수 있다고 가정하고, 공통 전처리에서
  균일 격자로 리샘플링한다. (RIAV/RIFV 는 박동당 1개라 반드시 필요)

미구현(TODO)은 팀 분담에 맞춰 표시해 두었다.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np
from scipy import signal as sps

from confidence import (BAND_RR, Band, GateContext, VitalEstimator, VitalReading,
                        fuse)


# ===========================================================================
# 공통 전처리 — 비균일 표본 → 균일 격자 → detrend → 대역통과
# ===========================================================================

RESAMPLE_FS = 4.0   # Hz. 호흡 상한 0.5Hz의 8배. HRV 관례와 동일.


def resample_uniform(t: np.ndarray, v: np.ndarray, fs: float = RESAMPLE_FS):
    """비균일 표본을 균일 격자로. RIAV/RIFV 처럼 박동당 1개인 신호에 필수.

    이 단계를 빼먹으면 FFT가 조용히 틀린 답을 낸다 — 가장 흔한 버그.
    """
    t = np.asarray(t, float)
    v = np.asarray(v, float)
    if len(t) < 4:
        return np.array([]), np.array([])
    order = np.argsort(t)
    t, v = t[order], v[order]
    grid = np.arange(t[0], t[-1], 1.0 / fs)
    if len(grid) < 8:
        return np.array([]), np.array([])
    return grid, np.interp(grid, t, v)


def preprocess(v: np.ndarray, fs: float, band: Band = BAND_RR) -> np.ndarray:
    """detrend + 대역통과. 심박 성분(≈1Hz+)은 여기서 완전히 제거된다."""
    if len(v) < 16:
        return np.asarray(v, float)
    x = sps.detrend(np.asarray(v, float), type="linear")
    nyq = fs / 2.0
    hi = min(band.f_hi, nyq * 0.95)
    if band.f_lo >= hi:
        return x
    sos = sps.butter(3, [band.f_lo, hi], btype="band", fs=fs, output="sos")
    return sps.sosfiltfilt(sos, x)


# ===========================================================================
# 신호원 (Source) — 프레임/박동마다 스칼라 하나를 쌓는다
# ===========================================================================

class RespirationSource(ABC):
    """모든 호흡 신호원의 공통 인터페이스.

    새 센서를 붙인다 == 이 클래스와 confidence.GateContext 를 하나씩 구현한다.
    (열화상 콧구멍 온도, 레이더 위상, 깊이카메라 흉부 변위 …)
    """
    name: str = "base"
    kind: str = "unknown"      # "motion" | "ppg_modulation" | "thermal" | ...

    def __init__(self, max_seconds: float = 60.0, nominal_rate: float = 30.0):
        self._buf: deque = deque(maxlen=int(max_seconds * nominal_rate))

    def _push(self, t: float, v: float) -> None:
        if np.isfinite(v):
            self._buf.append((float(t), float(v)))

    def series(self):
        if len(self._buf) < 8:
            return np.array([]), np.array([])
        arr = np.array(self._buf, float)
        return arr[:, 0], arr[:, 1]

    def ready(self, min_seconds: float) -> bool:
        t, _ = self.series()
        return len(t) >= 8 and (t[-1] - t[0]) >= min_seconds

    @abstractmethod
    def update(self, *args, **kwargs) -> None:
        """프레임 단위 관측을 받아 내부 시계열을 갱신한다."""


# --- 경로 A: 기계적 변위 ---------------------------------------------------

class ChestMotionSource(RespirationSource):
    """흉·복부 ROI의 수직 광류 성분 (경로 A).

    조밀 광류장을 스칼라로 축약: s(t) = mean(v_y over ROI).
    영상 파이프라인이 이미 계산한 값을 넣어주면 되므로 여기서는 영상을 보지 않는다.
    """
    name = "chest_motion"
    kind = "motion"

    def __init__(self, integrate: bool = True, **kw):
        super().__init__(**kw)
        # 광류는 '속도'다. 호흡은 '변위'로 보는 편이 파형이 자연스러워
        # 적분(누적합)을 기본으로 둔다. 대신 드리프트가 생기므로 전처리에서
        # detrend + 고역차단이 반드시 뒤따라야 한다.
        self.integrate = integrate
        self._acc = 0.0

    def update(self, t: float, vy: float) -> None:
        if not np.isfinite(vy):
            return
        if self.integrate:
            self._acc += float(vy)
            self._push(t, self._acc)
        else:
            self._push(t, vy)


class LandmarkSource(RespirationSource):
    """어깨/목 랜드마크의 y좌표 (경로 A).

    광류보다 가볍고 Pi 친화적. 옷 주름 같은 국소 텍스처에 덜 흔들린다.
    TODO(하드웨어·카메라 담당): MediaPipe Pose 또는 good-features + LK 로 채울 것.
    """
    name = "landmark_y"
    kind = "motion"

    def update(self, t: float, y: float) -> None:
        self._push(t, y)


# --- 경로 B: 맥파 변조 복조 -------------------------------------------------

class _PPGModulationSource(RespirationSource):
    """맥파 변조 계열의 공통 부모. 내부에 박동 검출기를 갖는다.

    ★ 지연 평가(lazy). update() 는 샘플만 쌓고, 무거운 복조는 series() 가
      호출될 때 한 번만 한다. 샘플마다 전체 재계산하면 O(n^2) 이 되어
      Pi 에서 즉시 무너진다 — 실제로 selftest 가 이 문제로 타임아웃났다.
    """
    kind = "ppg_modulation"

    def __init__(self, ppg_fs: float = 30.0, **kw):
        super().__init__(**kw)
        self.ppg_fs = ppg_fs
        self._ppg: deque = deque(maxlen=int(ppg_fs * 60))
        self._dirty = True

    def update(self, t: float, ppg_sample: float) -> None:
        if np.isfinite(ppg_sample):
            self._ppg.append((float(t), float(ppg_sample)))
            self._dirty = True

    def series(self):
        if self._dirty:
            self._recompute()
            self._dirty = False
        return super().series()

    def ready(self, min_seconds: float) -> bool:
        # 복조 전에 원본 PPG 길이만 보고 값싸게 판정한다
        if len(self._ppg) < 8:
            return False
        span = self._ppg[-1][0] - self._ppg[0][0]
        return span >= min_seconds

    def _beats(self):
        """박동 위치 검출. 반환: (박동시각, 파형)"""
        if len(self._ppg) < int(self.ppg_fs * 4):
            return None, None, None
        arr = np.array(self._ppg, float)
        t, x = arr[:, 0], arr[:, 1]
        x = sps.detrend(x, type="linear")
        sos = sps.butter(3, [0.7, 3.0], btype="band", fs=self.ppg_fs, output="sos")
        xf = sps.sosfiltfilt(sos, x)
        peaks, _ = sps.find_peaks(xf, distance=int(self.ppg_fs / 3.0),
                                  prominence=np.std(xf) * 0.3)
        if len(peaks) < 4:
            return None, None, None
        return t[peaks], xf, peaks

    @abstractmethod
    def _recompute(self) -> None:
        ...


class RIAVSource(_PPGModulationSource):
    """RIIV/RIAV 중 진폭 변조 — 박동별 peak-to-trough 진폭의 포락선.

    비균일 표본(박동당 1개)을 낸다 → 공통 전처리에서 리샘플링됨.
    """
    name = "riav"

    def _recompute(self):
        bt, xf, peaks = self._beats()
        if bt is None:
            return
        amps = []
        for i in range(len(peaks) - 1):
            seg = xf[peaks[i]:peaks[i + 1]]
            amps.append(float(xf[peaks[i]] - seg.min()) if len(seg) else np.nan)
        self._buf.clear()
        for t_i, a in zip(bt[:-1], amps):
            self._push(t_i, a)


class RIFVSource(_PPGModulationSource):
    """RIFV(RSA) — 박동 간격 시계열(tachogram).

    들숨에 심박↑, 날숨에 심박↓. 자율신경 매개라 개인차·연령차가 크다.
    (고령자는 RSA 진폭이 작아진다 — 우리 타깃에선 약점이 될 수 있음)
    """
    name = "rifv"

    def _recompute(self):
        bt, _, _ = self._beats()
        if bt is None:
            return
        ibi = np.diff(bt)
        ok = (ibi > 0.3) & (ibi < 2.0)          # 생리학적 범위 밖은 검출 오류
        self._buf.clear()
        for t_i, v in zip(bt[1:][ok], ibi[ok]):
            self._push(t_i, v)


class RIIVSource(_PPGModulationSource):
    """RIIV — 맥파 기저선의 저주파 변동. 가장 단순하고 종종 가장 강하다."""
    name = "riiv"

    def _recompute(self):
        if len(self._ppg) < int(self.ppg_fs * 4):
            return
        arr = np.array(self._ppg, float)
        t, x = arr[:, 0], arr[:, 1]
        # 심박 대역을 지우고 남는 저주파 = 기저선
        sos = sps.butter(3, 0.6, btype="low", fs=self.ppg_fs, output="sos")
        base = sps.sosfiltfilt(sos, sps.detrend(x, type="linear"))
        self._buf.clear()
        step = max(int(self.ppg_fs / RESAMPLE_FS), 1)   # 과표본 방지
        for t_i, v in zip(t[::step], base[::step]):
            self._push(t_i, v)


# ===========================================================================
# 주파수 추정기 — 교체 가능
# ===========================================================================

class FrequencyEstimator(ABC):
    name = "base"
    # 대역통과를 거친 신호를 원하는가? AR 계열은 False 여야 한다 —
    # Butterworth 가 자기 극점을 신호에 심으면 AR 이 한정된 차수를 그 극점을
    # 설명하는 데 낭비한다. (실측: 10~15초 윈도우에서 detrend-only 가 유의하게 우수)
    wants_bandpass = True

    @abstractmethod
    def estimate(self, x: np.ndarray, fs: float, band: Band) -> float:
        """전처리된 신호에서 대표 주파수(bpm)를 낸다. 실패 시 nan."""


class FFTEstimator(FrequencyEstimator):
    """zero-padding + 포물선 보간. v2 데모와 같은 계열.

    주의: zero-padding 은 '피크 위치 추정'을 정밀하게 할 뿐,
    가까운 두 성분을 분리하는 '분해능'은 높이지 못한다 (Δf ≈ 1/T).
    """
    name = "fft"

    def __init__(self, pad_factor: int = 8):
        self.pad = pad_factor

    def estimate(self, x, fs, band):
        n = len(x)
        if n < 16:
            return float("nan")
        w = np.hanning(n)
        nfft = int(2 ** math.ceil(math.log2(n * self.pad)))
        psd = np.abs(np.fft.rfft(x * w, n=nfft)) ** 2
        freqs = np.fft.rfftfreq(nfft, d=1.0 / fs)
        m = (freqs >= band.f_lo) & (freqs <= band.f_hi)
        if not m.any():
            return float("nan")
        i = int(np.argmax(np.where(m, psd, 0.0)))
        if 0 < i < len(psd) - 1:
            a, b, c = psd[i - 1], psd[i], psd[i + 1]
            d = a - 2 * b + c
            delta = 0.5 * (a - c) / d if abs(d) > 1e-20 else 0.0
            return float((freqs[i] + np.clip(delta, -1, 1) * (freqs[1] - freqs[0])) * 60)
        return float(freqs[i] * 60)


class AutocorrEstimator(FrequencyEstimator):
    """자기상관 첫 피크 = 주기. 광대역 잡음에 상대적으로 강하다."""
    name = "autocorr"

    def estimate(self, x, fs, band):
        n = len(x)
        if n < 32:
            return float("nan")
        x = x - x.mean()
        ac = np.correlate(x, x, mode="full")[n - 1:]
        if ac[0] <= 0:
            return float("nan")
        ac = ac / ac[0]
        lo = int(fs / band.f_hi)     # 최소 지연 (최고 주파수)
        hi = int(fs / band.f_lo)     # 최대 지연
        hi = min(hi, len(ac) - 1)
        if hi <= lo + 2:
            return float("nan")
        seg = ac[lo:hi]
        peaks, _ = sps.find_peaks(seg)
        if len(peaks) == 0:
            return float("nan")
        lag = lo + int(peaks[np.argmax(seg[peaks])])
        return float(60.0 * fs / lag) if lag > 0 else float("nan")


def burg_ar(x: np.ndarray, order: int) -> np.ndarray:
    """Burg 법 AR 계수 추정.

    짧은 데이터에서 주기도보다 분해능이 좋다 — 호흡처럼 윈도우 길이가
    제약인 협대역 신호에 유리. HRV 분석의 표준 도구이기도 하다.
    """
    x = np.asarray(x, float)
    N = len(x)
    if N < order + 2:
        return np.array([1.0])
    f = x.copy()
    b = x.copy()
    a = np.zeros(order + 1)
    a[0] = 1.0
    Dk = 2.0 * float(np.dot(x, x)) - x[0] ** 2 - x[N - 1] ** 2
    for k in range(order):
        if abs(Dk) < 1e-300:
            break
        mu = -2.0 * float(np.dot(f[k + 1:N], b[k:N - 1])) / Dk
        a_old = a.copy()
        for n in range(1, k + 2):
            a[n] = a_old[n] + mu * a_old[k + 1 - n]
        for n in range(N - 1, k, -1):
            ft = f[n] + mu * b[n - 1]
            b[n] = b[n - 1] + mu * f[n]
            f[n] = ft
        Dk = (1.0 - mu * mu) * Dk - f[k + 1] ** 2 - b[N - 1] ** 2
        if Dk <= 0:
            break
    return a


class BurgAREstimator(FrequencyEstimator):
    """AR 스펙트럼의 최대점. 차수는 데이터 길이의 1/3 이하로 제한.

    ★ 실측 결과(selftest): 대역통과를 먹이면 오히려 나빠진다. detrend 만 한
      신호를 받도록 wants_bandpass=False 로 둔다.
    ★ 실측 결과2: 단일 피크 위치 추정에서는 zero-padded FFT 가 전 구간에서
      더 정확했다. Burg 는 주 추정기가 아니라 '독립적인 교차검증용'으로 쓴다.
    """
    name = "burg"
    wants_bandpass = False

    def __init__(self, order: int = 12):
        self.order = order

    def estimate(self, x, fs, band):
        n = len(x)
        if n < 32:
            return float("nan")
        order = int(min(self.order, max(4, n // 3)))
        a = burg_ar(x, order)
        if len(a) < 2:
            return float("nan")
        freqs = np.linspace(band.f_lo, band.f_hi, 512)
        w = 2 * np.pi * freqs / fs
        k = np.arange(len(a))
        A = np.exp(-1j * np.outer(w, k)) @ a       # A(e^{jw})
        psd = 1.0 / np.maximum(np.abs(A) ** 2, 1e-30)
        return float(freqs[int(np.argmax(psd))] * 60)


class PeakCountEstimator(FrequencyEstimator):
    """시간영역 피크 계수. 가장 빠르게 반응하며, FFT와의 불일치가
    그 자체로 품질 지표가 된다. (Jakkaew 2020 은 영교차 계수를 사용)"""
    name = "peak_count"

    def estimate(self, x, fs, band):
        if len(x) < 32:
            return float("nan")
        dist = max(int(fs / band.f_hi * 0.7), 1)
        peaks, _ = sps.find_peaks(x, distance=dist, prominence=np.std(x) * 0.3)
        if len(peaks) < 3:
            return float("nan")
        med = float(np.median(np.diff(peaks) / fs))
        return 60.0 / med if med > 0 else float("nan")


# FFT 가 주 추정기. 나머지 셋은 서로 다른 원리의 교차검증용으로 두어,
# 이들 간 불일치를 confidence 의 agreement 성분에 쓴다.
DEFAULT_ESTIMATORS = [FFTEstimator(), AutocorrEstimator(),
                      BurgAREstimator(), PeakCountEstimator()]


# ===========================================================================
# 오케스트레이션
# ===========================================================================

@dataclass
class SourceResult:
    source: str
    kind: str
    bpm: float
    reading: Optional[VitalReading]
    per_estimator: dict


class RespirationEstimator:
    """여러 Source × 여러 Estimator → confidence 평가 → 융합.

    사용:
        est = RespirationEstimator([ChestMotionSource(), RIAVSource(ppg_fs=30)])
        est.sources[0].update(t, vy)
        est.sources[1].update(t, ppg_sample)
        out = est.compute(ctx, t_now)
    """

    def __init__(self,
                 sources: Sequence[RespirationSource],
                 estimators: Sequence[FrequencyEstimator] = None,
                 band: Band = BAND_RR,
                 fs: float = RESAMPLE_FS,
                 calibration=None):
        self.sources = list(sources)
        self.estimators = list(estimators or DEFAULT_ESTIMATORS)
        self.band = band
        self.fs = fs
        # Source 마다 독립적인 confidence 상태를 갖는다 (시간적 일관성 추적용)
        self._vital = {s.name: VitalEstimator(band, fs, calibration)
                       for s in self.sources}

    def compute(self, ctx, t_now: float):
        """ctx: 모든 Source 가 같은 센서에서 나오면 GateContext 하나를 넘긴다.
        센서가 섞여 있으면 {source_name: GateContext} 를 넘긴다 — 열화상이 코를
        놓쳤는데 가시광은 가슴을 잘 보고 있는 상황을 표현하려면 게이트가
        Source 별로 독립이어야 한다.
        """
        results = []
        for src in self.sources:
            if not src.ready(self.band.min_window_sec):
                continue
            src_ctx: GateContext = ctx[src.name] if isinstance(ctx, dict) else ctx
            t, v = src.series()
            grid, vv = resample_uniform(t, v, self.fs)
            if len(vv) < 32:
                continue
            x_bp = preprocess(vv, self.fs, self.band)          # 대역통과
            x_dt = sps.detrend(vv, type="linear")               # detrend만

            per_est = {e.name: e.estimate(x_bp if e.wants_bandpass else x_dt,
                                          self.fs, self.band)
                       for e in self.estimators}

            # confidence 모듈은 전처리된 신호를 그대로 받는다
            reading = self._vital[src.name].update(x_bp, src_ctx, t_now)
            results.append(SourceResult(src.name, src.kind,
                                        reading.bpm if reading.ok else float("nan"),
                                        reading, per_est))

        readings = [r.reading for r in results if r.reading is not None]
        bpm, conf = fuse(readings) if readings else (float("nan"), 0.0)
        return bpm, conf, results


# ===========================================================================
# TODO — 다음 단계 (역할별)
# ===========================================================================
# [신호처리]  RIAV/RIFV 의 박동 검출기를 v2 의 peak interpolation 과 통일
# [하드웨어]  LandmarkSource 를 MediaPipe Pose 또는 LK 추적으로 구현
# [검증]      메트로놈 호흡(10/12/15/20 bpm)으로 Estimator 4종 벤치마크
# [검증]      복부 ROI vs 흉부 ROI 비교 — 누운 자세에선 복부가 유리할 것
# [확장]      ThermalNostrilSource(RespirationSource) — 열화상 도입 시
