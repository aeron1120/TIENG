"""
호흡수 골조 검증 — 카메라 없이 합성 신호로.

검증 항목
1. 네 가지 주파수 추정기가 각각 얼마나 정확한가 (이론 비교의 실증)
2. 시간-주파수 불확정성이 실제로 관측되는가 (윈도우 길이별 오차)
3. 맥파 변조(RIAV/RIFV/RIIV) 복조가 실제로 호흡을 복원하는가
4. 다중 신호원 융합이 단일 신호원보다 나은가
"""

import sys

# Windows 콘솔 기본 인코딩(cp949)에서는 한글/em dash 출력이 UnicodeEncodeError를 낸다.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np

from confidence import BAND_RR, FrameContext
from respiration import (
    ChestMotionSource, RIAVSource, RIFVSource, RIIVSource,
    FFTEstimator, AutocorrEstimator, BurgAREstimator, PeakCountEstimator,
    RespirationEstimator, resample_uniform, preprocess, RESAMPLE_FS,
)

RNG = np.random.default_rng(7)
CTX = FrameContext(roi_found=True, roi_mean_intensity=120.0,
                   motion_magnitude=0.5, fps_jitter=0.04)


def pink(n):
    f = np.fft.rfftfreq(n, 1.0)
    f[0] = f[1] if len(f) > 1 else 1.0
    s = (RNG.normal(0, 1, len(f)) + 1j * RNG.normal(0, 1, len(f))) / np.sqrt(f)
    x = np.fft.irfft(s, n=n)
    return x / (np.std(x) or 1.0)


def resp_signal(rr_bpm, fs, seconds, snr_db):
    """호흡 파형. 실제 호흡은 정현파가 아니다 — 날숨이 더 길다(비대칭)."""
    n = int(fs * seconds)
    t = np.arange(n) / fs
    f = rr_bpm / 60.0
    ph = 2 * np.pi * f * t
    sig = np.sin(ph) + 0.25 * np.sin(2 * ph + 0.6)     # 비대칭 → 2차 배음
    p = np.mean(sig ** 2)
    return t, sig + np.sqrt(p / 10 ** (snr_db / 10)) * pink(n)


# ---------------------------------------------------------------------------
# 1. 추정기 4종 비교
# ---------------------------------------------------------------------------

def test_estimators():
    print("\n[1] 주파수 추정기 4종 비교  (30초 윈도우, 4Hz 리샘플)")
    ests = [FFTEstimator(), AutocorrEstimator(), BurgAREstimator(), PeakCountEstimator()]
    for snr in (6, 0, -6):
        errs = {e.name: [] for e in ests}
        for _ in range(200):
            true = RNG.uniform(9, 22)
            _, x = resp_signal(true, RESAMPLE_FS, 30.0, snr)
            xf = preprocess(x, RESAMPLE_FS, BAND_RR)
            for e in ests:
                b = e.estimate(xf, RESAMPLE_FS, BAND_RR)
                if np.isfinite(b):
                    errs[e.name].append(abs(b - true))
        line = "  ".join(f"{k:>10s} {np.mean(v):5.2f}" for k, v in errs.items() if v)
        print(f"  SNR {snr:+3d}dB | {line}   (MAE bpm)")


# ---------------------------------------------------------------------------
# 2. 시간-주파수 불확정성
# ---------------------------------------------------------------------------

def test_uncertainty():
    print("\n[2] 윈도우 길이 vs 정확도 — Δf ≈ 1/T 가 실제로 나타나는가")
    est = FFTEstimator()
    print("   윈도우   이론 분해능    실측 MAE   (12bpm 기준 주기 수)")
    for secs in (10, 15, 20, 30, 45, 60):
        errs = []
        for _ in range(300):
            true = RNG.uniform(9, 22)
            _, x = resp_signal(true, RESAMPLE_FS, secs, 0.0)
            xf = preprocess(x, RESAMPLE_FS, BAND_RR)
            b = est.estimate(xf, RESAMPLE_FS, BAND_RR)
            if np.isfinite(b):
                errs.append(abs(b - true))
        theo = 60.0 / secs          # Δf=1/T → bpm 환산
        cycles = secs * 12 / 60
        print(f"   {secs:3d}s    {theo:6.2f} bpm    {np.mean(errs):6.2f} bpm"
              f"   ({cycles:.0f}주기)")
    print("   → 윈도우가 짧으면 이론 분해능이 오차의 하한을 만든다.")
    print("     3주기 미만(15초 이하)에서 급격히 나빠지는 것이 핵심.")


# ---------------------------------------------------------------------------
# 3. 맥파 변조 복조
# ---------------------------------------------------------------------------

def test_ppg_modulation():
    print("\n[3] 맥파 변조 복조 — RIAV / RIFV / RIIV 가 호흡을 복원하는가")
    fs, secs = 30.0, 60.0
    hr, rr = 72.0, 15.0
    n = int(fs * secs)
    t = np.arange(n) / fs
    fr = rr / 60.0

    # 호흡이 진폭·기저선·순간심박을 각각 변조하는 맥파를 합성
    amp = 1.0 + 0.30 * np.sin(2 * np.pi * fr * t)              # RIAV
    base = 0.45 * np.sin(2 * np.pi * fr * t + 1.1)             # RIIV
    inst_hr = hr * (1 + 0.10 * np.sin(2 * np.pi * fr * t))     # RIFV(RSA)
    ph = 2 * np.pi * np.cumsum(inst_hr / 60.0) / fs
    ppg = amp * (np.sin(ph) + 0.3 * np.sin(2 * ph)) + base
    ppg += 0.08 * pink(n)

    for cls in (RIAVSource, RIFVSource, RIIVSource):
        src = cls(ppg_fs=fs, max_seconds=secs + 5, nominal_rate=fs)
        for i in range(n):
            src.update(t[i], ppg[i])
        ts, vs = src.series()
        if len(ts) < 8:
            print(f"   {src.name:>6s} : 표본 부족")
            continue
        grid, vv = resample_uniform(ts, vs, RESAMPLE_FS)
        xf = preprocess(vv, RESAMPLE_FS, BAND_RR)
        bpm = FFTEstimator().estimate(xf, RESAMPLE_FS, BAND_RR)
        err = abs(bpm - rr)
        print(f"   {src.name:>6s} : {bpm:5.2f} bpm  (참값 {rr:.0f}, 오차 {err:4.2f})  "
              f"{'PASS' if err < 1.5 else 'FAIL'}   표본 {len(ts)}개")


# ---------------------------------------------------------------------------
# 4. 융합
# ---------------------------------------------------------------------------

def test_fusion():
    print("\n[4] 다중 신호원 융합 vs 단일 신호원")
    fs, secs = 30.0, 40.0
    single, fused = [], []
    for _ in range(120):
        rr = RNG.uniform(10, 20)
        n = int(fs * secs)
        t = np.arange(n) / fs
        fr = rr / 60.0

        # 경로 A: 흉부 움직임(광류 속도 → Source가 적분)
        vel = 2 * np.pi * fr * np.cos(2 * np.pi * fr * t) + 0.9 * pink(n)
        # 경로 B: 맥파 (진폭 변조)
        amp = 1.0 + 0.30 * np.sin(2 * np.pi * fr * t + 0.4)
        ph = 2 * np.pi * 70.0 / 60.0 * t
        ppg = amp * np.sin(ph) + 0.25 * pink(n)

        est = RespirationEstimator(
            [ChestMotionSource(max_seconds=secs + 5, nominal_rate=fs),
             RIAVSource(ppg_fs=fs, max_seconds=secs + 5, nominal_rate=fs)])
        for i in range(n):
            est.sources[0].update(t[i], vel[i])
            est.sources[1].update(t[i], ppg[i])

        bpm, conf, res = est.compute(CTX, secs)
        if not res or not np.isfinite(bpm):
            continue
        s0 = next((r.bpm for r in res if np.isfinite(r.bpm)), np.nan)
        if np.isfinite(s0):
            single.append(abs(s0 - rr))
            fused.append(abs(bpm - rr))

    if single:
        s, f = np.mean(single), np.mean(fused)
        print(f"   단일 신호원 MAE : {s:.2f} bpm")
        print(f"   융합       MAE : {f:.2f} bpm  ({(1-f/s)*100:+.0f}%)  "
              f"{'PASS' if f <= s else 'FAIL'}")
        print(f"   (n={len(single)})")


if __name__ == "__main__":
    print("=" * 70)
    print("TouchFree Vitals — 호흡수 골조 검증")
    print("=" * 70)
    test_estimators()
    test_uncertainty()
    test_ppg_modulation()
    test_fusion()
    print()
