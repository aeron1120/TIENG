"""
confidence 모듈 자체 검증 — 카메라 없이 합성 신호로 돌린다.
(v2 데모의 selftest 모드와 같은 철학)

검증 항목
1. confidence가 실제 오차와 실제로 음의 상관을 갖는가  ← 이게 되면 캘리브레이션이 성립
2. 캘리브레이션 표가 단조 감소하는가
3. 목표 MAE로부터 임계값이 역산되는가
4. 히스테리시스가 경계에서의 깜빡임을 실제로 줄이는가
5. 융합이 단일 추정보다 나은가

실행:  python3 selftest_confidence.py
"""

import sys

# Windows 콘솔 기본 인코딩(cp949)에서는 한글/em dash 출력이 UnicodeEncodeError를 낸다.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from scipy import stats

from confidence import (
    BAND_HR, BAND_RR, FrameContext, VitalEstimator, Calibration,
    DecisionPolicy, DisplayState, AlertPolicy, fuse,
)

RNG = np.random.default_rng(20260727)

# 한글 폰트 (없으면 조용히 기본값 유지)
for _f in ("Noto Sans CJK KR", "Noto Sans CJK JP", "NanumGothic", "Malgun Gothic"):
    if any(_f in f.name for f in font_manager.fontManager.ttflist):
        plt.rcParams["font.family"] = _f
        break
plt.rcParams["axes.unicode_minus"] = False


# ---------------------------------------------------------------------------
# 합성 신호 생성기
# ---------------------------------------------------------------------------

def _pink(n):
    """1/f 잡음. 실제 rPPG 잡음은 백색이 아니라 저주파에 치우쳐 있다."""
    f = np.fft.rfftfreq(n, d=1.0)
    f[0] = f[1] if len(f) > 1 else 1.0
    spec = (RNG.normal(0, 1, len(f)) + 1j * RNG.normal(0, 1, len(f))) / np.sqrt(f)
    x = np.fft.irfft(spec, n=n)
    s = np.std(x)
    return x / (s if s > 0 else 1.0)


def synth(bpm, fps, seconds, snr_db, harmonic=0.35,
          motion_bpm=None, motion_amp=0.0, drift_bpm=0.0):
    """생리학적 신호 + 1/f 잡음 + (선택) 움직임 아티팩트.

    drift_bpm: 윈도우 안에서 심박/호흡이 이만큼 변한다(비정상 신호).
               실제 rPPG 오차의 상당 부분이 여기서 온다.
    """
    n = int(fps * seconds)
    t = np.arange(n) / fps

    # 윈도우 내 주파수 드리프트 + HRV성 미세 변동
    inst_bpm = bpm + drift_bpm * (t / max(t[-1], 1e-9) - 0.5)
    inst_f = inst_bpm / 60.0
    phase = 2 * np.pi * np.cumsum(inst_f) / fps
    phase += 0.15 * np.sin(2 * np.pi * 0.25 * t)      # HRV/호흡성 위상 변동
    sig = np.sin(phase) + harmonic * np.sin(2 * phase)

    if motion_bpm is not None and motion_amp > 0:
        # 움직임도 완전한 정현파가 아니다 — 주파수가 흔들리고 배음이 거의 없다
        mf = (motion_bpm / 60.0) * (1 + 0.08 * np.sin(2 * np.pi * 0.11 * t))
        mph = 2 * np.pi * np.cumsum(mf) / fps + 0.7
        sig = sig + motion_amp * (np.sin(mph) + 0.25 * _pink(n))

    p_sig = float(np.mean(sig ** 2))
    p_noise = p_sig / (10 ** (snr_db / 10.0))
    noise = np.sqrt(p_noise) * _pink(n)
    return sig + noise


GOOD_CTX = FrameContext(roi_found=True, roi_mean_intensity=120.0,
                        roi_saturated_frac=0.01, roi_dark_frac=0.02,
                        motion_magnitude=0.5, fps_jitter=0.05)


# ---------------------------------------------------------------------------
# 1) confidence vs 실제 오차
# ---------------------------------------------------------------------------

def collect(band, fps, seconds, n_trials=600, bpm_range=(55, 95)):
    confs, errs, oks = [], [], 0
    drift_scale = 6.0 if band.name == "HR" else 2.5
    for _ in range(n_trials):
        true_bpm = RNG.uniform(*bpm_range)
        snr = RNG.uniform(-16, 8)
        # 35% 확률로 움직임 아티팩트 주입 (실제 실패 모드 재현)
        if RNG.random() < 0.35:
            m_bpm = RNG.uniform(band.bpm_lo, band.bpm_hi)
            m_amp = RNG.uniform(0.4, 1.8)
        else:
            m_bpm, m_amp = None, 0.0

        x = synth(true_bpm, fps, seconds, snr, motion_bpm=m_bpm, motion_amp=m_amp,
                  drift_bpm=RNG.uniform(-drift_scale, drift_scale))
        est = VitalEstimator(band, fps)
        r = est.update(x, GOOD_CTX, t_now=0.0)
        if not r.ok:
            continue
        oks += 1
        confs.append(r.confidence)
        errs.append(r.bpm - true_bpm)
    return np.array(confs), np.array(errs), oks


def main():
    fps = 30.0
    print("=" * 68)
    print("TouchFree Vitals — confidence 모듈 자체 검증")
    print("=" * 68)

    results = {}
    for band, secs, rng_bpm in [(BAND_HR, 10.0, (55, 95)), (BAND_RR, 30.0, (10, 22))]:
        c, e, n = collect(band, fps, secs, n_trials=700, bpm_range=rng_bpm)
        results[band.name] = (band, c, e)

        # --- 1. 상관 ---
        # 오차 분포가 심하게 치우쳐 있어(대부분 작고 일부만 폭발) Pearson은
        # 부적절하다. 순위상관(Spearman)으로 단조 관계를 본다.
        rho = float(stats.spearmanr(c, np.abs(e)).statistic)
        print(f"\n[{band.name}]  윈도우 {secs:.0f}s, 유효 시행 {n}")
        print(f"  1. confidence ↔ |오차| 순위상관 : {rho:+.3f}  "
              f"{'PASS (음의 상관)' if rho < -0.3 else 'FAIL'}")

        # --- 2. 캘리브레이션 ---
        cal = Calibration.fit(c, e, n_bins=10)
        finite = cal.maes[np.isfinite(cal.maes)]
        mono = bool(np.all(np.diff(finite) <= 1e-9))
        print(f"  2. 캘리브레이션 단조 감소       : {'PASS' if mono else 'FAIL'}")
        print("     confidence 구간   실측 MAE    표본")
        for i in range(len(cal.maes)):
            lo, hi = cal.edges[i], cal.edges[i + 1]
            m = cal.maes[i]
            bar = "█" * int(min(m, 30)) if np.isfinite(m) else ""
            print(f"       {lo:.1f}–{hi:.1f}    {m:8.2f} bpm  {cal.counts[i]:4d}  {bar}")

        # --- 3. 목표 오차 → 임계값 역산 ---
        target = 5.0 if band.name == "HR" else 2.0
        th = cal.threshold_for_mae(target)
        print(f"  3. MAE≤{target:.0f}bpm 목표 → 임계 confidence = {th:.2f}")

        # 실제로 그 임계값에서 목표를 달성하는지 확인
        keep = c >= th
        if keep.sum():
            achieved = float(np.mean(np.abs(e[keep])))
            hold = 1.0 - keep.mean()
            ok = achieved <= target * 1.15
            print(f"     검증: 보류율 {hold*100:.0f}% 에서 실측 MAE {achieved:.2f} bpm  "
                  f"{'PASS' if ok else 'FAIL'}")

        cal.save(f"calibration_{band.name}.json")
        results[band.name] = (band, c, e, cal)

    # --- 4. 히스테리시스 ---
    print("\n[히스테리시스]")
    band, c, e, cal = results["HR"]
    # 임계값 경계를 왔다갔다 하는 confidence 시퀀스를 만든다
    seq = 0.56 + 0.05 * np.sin(np.linspace(0, 12 * np.pi, 200)) + RNG.normal(0, 0.02, 200)

    def count_flips(hyst):
        pol = DecisionPolicy(t_exact=0.75, t_range=0.55, t_trend=0.40, hysteresis=hyst)
        from confidence import VitalReading, GateReason
        states, flips = None, 0
        for v in seq:
            r = VitalReading("HR", True, GateReason.OK, bpm=70.0,
                             confidence=float(np.clip(v, 0, 1)), expected_mae=4.0)
            d = pol.decide(r)
            if states is not None and d.state != states:
                flips += 1
            states = d.state
        return flips

    f0, f1 = count_flips(0.0), count_flips(0.08)
    print(f"  히스테리시스 없음 : 상태 전환 {f0:3d}회")
    print(f"  히스테리시스 0.08 : 상태 전환 {f1:3d}회   "
          f"({(1-f1/max(f0,1))*100:.0f}% 감소)  {'PASS' if f1 < f0 else 'FAIL'}")

    # --- 5. 융합 ---
    print("\n[융합] 독립 추정 2개 vs 단일 추정")
    single_err, fused_err = [], []
    for _ in range(400):
        true_bpm = RNG.uniform(55, 95)
        # 서로 다른 원리의 두 센서 = 독립적인 잡음
        xa = synth(true_bpm, fps, 10.0, RNG.uniform(-6, 6))
        xb = synth(true_bpm, fps, 10.0, RNG.uniform(-6, 6))
        ra = VitalEstimator(BAND_HR, fps, cal).update(xa, GOOD_CTX, 0.0)
        rb = VitalEstimator(BAND_HR, fps, cal).update(xb, GOOD_CTX, 0.0)
        if not (ra.ok and rb.ok):
            continue
        bpm_f, _ = fuse([ra, rb])
        if np.isfinite(bpm_f):
            single_err.append(abs(ra.bpm - true_bpm))
            fused_err.append(abs(bpm_f - true_bpm))
    s, f = np.mean(single_err), np.mean(fused_err)
    print(f"  단일 센서 MAE : {s:.2f} bpm")
    print(f"  융합    MAE : {f:.2f} bpm   ({(1-f/s)*100:+.0f}%)  "
          f"{'PASS' if f < s else 'FAIL'}")

    # --- 6. 알림 정책 ---
    print("\n[알림] 저신뢰 이상값이 알림을 유발하지 않는지")
    from confidence import VitalReading, GateReason, AlertKind
    ap = AlertPolicy(lo=45, hi=100, min_conf=0.75, n_consecutive=5)
    fired = 0
    for i in range(50):   # 저신뢰인데 값은 이상 범위
        r = VitalReading("HR", True, GateReason.OK, bpm=140.0, confidence=0.5)
        if ap.update(r, float(i)).kind is not AlertKind.NONE:
            fired += 1
    print(f"  저신뢰 이상값 50회 → 알림 {fired}회  {'PASS' if fired == 0 else 'FAIL'}")

    ap2 = AlertPolicy(lo=45, hi=100, min_conf=0.75, n_consecutive=5)
    fired2 = sum(1 for i in range(10)
                 if ap2.update(VitalReading("HR", True, GateReason.OK, bpm=140.0,
                                            confidence=0.9), float(i)).kind
                 is not AlertKind.NONE)
    print(f"  고신뢰 이상값 10회 → 알림 {fired2}회  {'PASS' if fired2 >= 1 else 'FAIL'}")

    # --- 그래프 ---
    plot(results)
    print("\n저장: coverage_mae_curve.png, calibration_HR.json, calibration_RR.json")


def plot(results):
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.6))
    colors = {"HR": "#2563eb", "RR": "#0f766e"}

    for name, (band, c, e, cal) in results.items():
        curve = cal.coverage_curve(c, e)
        hold = [p[1] * 100 for p in curve]
        mae = [p[2] for p in curve]

        ax = axes[0] if name == "HR" else axes[1]
        ax.plot(hold, mae, color=colors[name], lw=2.2)
        target = 5.0 if name == "HR" else 2.0
        ax.axhline(target, color="#b91c1c", ls="--", lw=1.2,
                   label=f"목표 MAE {target:.0f} bpm")

        # 목표를 처음 만족하는 지점 표시
        for h, m in zip(hold, mae):
            if m <= target:
                ax.plot(h, m, "o", color="#b91c1c", ms=8, zorder=5)
                ax.annotate(f"보류율 {h:.0f}%\nMAE {m:.1f}",
                            (h, m), textcoords="offset points", xytext=(12, 14),
                            fontsize=9, color="#b91c1c")
                break

        ax.set_title(f"{name} — 보류율 vs 정확도", fontsize=12, fontweight="bold")
        ax.set_xlabel("측정 보류율 (%)")
        ax.set_ylabel("MAE (bpm)")
        ax.grid(alpha=0.25)
        ax.legend(fontsize=9)

    fig.suptitle("TouchFree Vitals — confidence 캘리브레이션 결과 (합성 신호 검증)",
                 fontsize=13, fontweight="bold")
    fig.tight_layout()
    fig.savefig("coverage_mae_curve.png", dpi=150)


if __name__ == "__main__":
    main()
