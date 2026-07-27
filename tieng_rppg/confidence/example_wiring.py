"""
confidence 모듈 배선 예제 — 카메라 없이 합성 신호로 전 경로를 한 번 돌린다.

    VitalEstimator → DecisionPolicy → AlertPolicy → fuse

이 파일은 '어떻게 쓰는가'만 보여준다. 실제 웹캠 파이프라인은
tieng_rppg/rppg_demo_v4.py 한 곳에만 있다 — 여기서 다시 구현하지 않는다.

웹캠에서 조심할 것 세 가지는 전부 데모 쪽에서 처리한다:
  (1) 오토 노출/화이트밸런스   → rppg_demo_v4.run_webcam 의 --lock-exposure
  (2) 실제 타임스탬프 + 리샘플링 → rppg_demo_v4 의 np.interp 균일 격자 변환
  (3) 얼굴 ROI와 상체 ROI 분리   → select_hr_roi / build_respiration_box

실행:  python example_wiring.py
"""

import sys

# Windows 콘솔 기본 인코딩(cp949)에서는 한글 출력이 UnicodeEncodeError를 낸다.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np

from confidence import (
    BAND_HR, BAND_RR, Calibration, FrameContext, VitalEstimator,
    DecisionPolicy, AlertPolicy, AlertKind, fuse,
)

FPS = 30.0


def ppg(bpm: float, seconds: float, snr: float, seed: int, fps: float = FPS) -> np.ndarray:
    """맥파 비슷한 합성 파형 + 대역 내 백색잡음.

    고조파를 반드시 넣어야 한다. 순수 정현파를 쓰면 score_harmonic 이 0에 가깝게
    나와서 깨끗한 신호인데도 confidence 가 눌린다 — 실제 맥파에는 2·3고조파가 있다.
    잡음도 저주파(핑크)가 아니라 백색이어야 대역 안에서 품질이 실제로 깎인다.
    """
    rng = np.random.default_rng(seed)
    t = np.arange(0, seconds, 1.0 / fps)
    f = bpm / 60.0
    x = (np.sin(2 * np.pi * f * t)
         + 0.40 * np.sin(2 * np.pi * 2 * f * t + 0.7)
         + 0.15 * np.sin(2 * np.pi * 3 * f * t + 1.3))
    x /= np.std(x)
    return x + rng.normal(0, 1.0 / max(snr, 1e-9), len(t))


GOOD_CTX = FrameContext(roi_found=True, roi_mean_intensity=120.0,
                        motion_magnitude=0.5, fps_jitter=0.03)


def load_calibration(path: str):
    try:
        return Calibration.load(path)
    except Exception:
        print(f"  {path} 없음 — expected_mae 는 None 이 된다")
        return None


def main() -> None:
    bar = "=" * 68
    print(bar)
    print("confidence 배선 예제 — VitalEstimator → DecisionPolicy → AlertPolicy")
    print(bar)

    cal_hr = load_calibration("calibration_HR.json")

    # --- 1. 신뢰도에 따라 표시 방식이 달라진다 --------------------------------
    # SQI 단일 게이트와의 가장 큰 차이. "숨기거나 보여주거나" 가 아니라
    # 믿을 만한 만큼만 보여준다 — 정확값 → 범위 → 추세 → 보류.
    print("\n[1] 신호 품질별 표시 방식  (DecisionPolicy 기본 임계 0.75/0.55/0.40)")
    for label, snr in (("깨끗함", 3.0), ("보통", 0.5), ("나쁨", 0.3), ("매우 나쁨", 0.15)):
        est = VitalEstimator(BAND_HR, FPS, cal_hr)
        policy = DecisionPolicy()
        r = est.update(ppg(72, 12.0, snr, seed=7), GOOD_CTX, t_now=0.0)
        d = policy.decide(r)
        mae = "—" if r.expected_mae is None else f"{r.expected_mae:5.2f}bpm"
        print(f"  {label:<9s} conf={r.confidence:.2f}  예상오차={mae:>9s}  "
              f"→ {d.state.label_ko:<6s} {d.text}")

    # --- 2. 목표 오차로부터 임계값 역산 ---------------------------------------
    if cal_hr is not None:
        print("\n[2] 캘리브레이션으로 임계값 역산 (눈대중 상수를 없애는 경로)")
        derived = DecisionPolicy.from_calibration(cal_hr, 3.0, 6.0, 12.0)
        got = {s.value: round(v, 3) for s, v in derived.t.items()}
        print(f"  목표 정확≤3 / 범위≤6 / 추세≤12 bpm  →  {got}")
        if len(set(got.values())) < len(got):
            print("  ※ 서로 다른 목표가 같은 임계값으로 뭉갠다. 캘리브레이션 표가")
            print("     confidence 를 10구간으로 비닝하고 MAE 곡선이 중간에서 평평해서다.")
            print("     표본을 늘리거나 구간을 잘게 나누기 전까지는 기본 임계값을 쓸 것.")

    # --- 3. 게이트 실패는 값이 아니라 사유를 돌려준다 --------------------------
    print("\n[3] 게이트 실패 — 왜 못 쟀는지가 남는다")
    est = VitalEstimator(BAND_HR, FPS, cal_hr)
    clean = ppg(72, 12.0, 3.0, seed=7)
    for label, bad in (
        ("얼굴 없음",   FrameContext(roi_found=False)),
        ("너무 어두움", FrameContext(roi_mean_intensity=20.0)),
        ("역광/포화",   FrameContext(roi_mean_intensity=240.0)),
        ("움직임 과다", FrameContext(roi_mean_intensity=120.0, motion_magnitude=9.0)),
        ("FPS 불안정",  FrameContext(roi_mean_intensity=120.0, fps_jitter=0.6)),
    ):
        r = est.update(clean, bad, t_now=0.0)
        print(f"  {label:<11s} → {r.reason.value:<18s} \"{r.reason.message_ko}\"")

    # --- 4. 알림은 표시보다 훨씬 보수적으로 -----------------------------------
    # 새벽 3시 오탐은 실제 피해다. 고신뢰 윈도우가 연속 N회 이상 범위일 때만 낸다.
    print("\n[4] 알림 판정 — 신뢰도 0.75 이상이 연속 5회일 때만")
    for label, snr in (("고신뢰 이상값", 3.0), ("저신뢰 이상값", 0.25)):
        est = VitalEstimator(BAND_HR, FPS, cal_hr)
        ap = AlertPolicy(lo=45, hi=110, min_conf=0.75, n_consecutive=5)
        fired, confs = [], []
        for i in range(8):
            r = est.update(ppg(130, 12.0, snr, seed=100 + i), GOOD_CTX, t_now=float(i))
            confs.append(r.confidence)
            a = ap.update(r, t_now=float(i))
            if a.kind is not AlertKind.NONE:
                fired.append(f"{i + 1}회차 {a.kind.value}")
        detail = f" ({', '.join(fired)})" if fired else ""
        print(f"  {label} 8회  conf 평균 {np.mean(confs):.2f}  →  알림 {len(fired)}회{detail}")
    print("  같은 이상값(130bpm)인데 신뢰도가 낮으면 아예 세지 않는다.")

    # --- 5. 융합 — 새 센서를 붙이는 지점 --------------------------------------
    # 열화상 콧구멍 온도든 레이더든, 리스트에 VitalReading 을 하나 더 넣으면 된다.
    print("\n[5] 다중 신호원 융합 — 어긋나면 신뢰도가 깎인다")
    reads = {}
    for key, (bpm, snr, seed) in {
        "A": (15, 3.0, 1), "B": (15, 2.0, 2), "C": (24, 2.0, 3),
    }.items():
        reads[key] = VitalEstimator(BAND_RR, FPS, None).update(
            ppg(bpm, 40.0, snr, seed=seed), GOOD_CTX, t_now=0.0)
        print(f"  {key}  conf={reads[key].confidence:.2f}  rpm={reads[key].bpm:.1f}")
    for label, pair in (("A+B 일치", ("A", "B")), ("A+C 불일치", ("A", "C"))):
        bpm, conf = fuse([reads[k] for k in pair])
        print(f"  {label:<11s} → rpm={bpm:5.1f}  융합 conf={conf:.2f}")

    print("\n" + bar)
    print("실제 웹캠 실행은 ../rppg_demo_v4.py 를 쓸 것.")
    print(bar)


if __name__ == "__main__":
    main()
