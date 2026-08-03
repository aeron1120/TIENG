"""
selftest — MLX90640 캡처 계층 (thermal_mlx90640.py) + ThermalNostrilSource

하드웨어가 아직 없으므로 전량 SyntheticThermalCamera 경로로 돈다. 실장비가
오면 이 파일은 그대로 두고, thermal_mlx90640.open_camera(force_synthetic=False)
로 바꿔 별도로 실측 검증할 것 (여기 있는 합성 검증을 대체하지 않는다 —
합성 경로는 신호처리 로직 검증용으로 계속 남겨둔다).

검증 항목
1. roi_stats: ROI 안/밖 픽셀 구분, 평균·대비 계산, 경계 클리핑
2. SyntheticThermalCamera → ThermalNostrilSource → RespirationEstimator
   합성 호흡(rpm 지정)을 얼마나 정확히 복원하는가
3. ThermalContext 게이트: roi_too_small / low_thermal_contrast / ffc_active 가
   실제로 막는가
"""

import sys

# Windows 콘솔 기본 인코딩(cp949)에서는 한글 출력이 UnicodeEncodeError를 낸다.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np

from confidence import BAND_RR, ThermalContext
from respiration import ThermalNostrilSource, RespirationEstimator
from thermal_mlx90640 import SyntheticThermalCamera, ThermalFrame, roi_stats


def test_roi_stats():
    print("\n[1] roi_stats 기본 동작")
    grid = np.full((24, 32), 20.0)
    grid[9:14, 13:19] = 33.0     # 5행 x 6열 = 30픽셀짜리 균일 ROI
    frame = ThermalFrame(t=0.0, grid=grid)

    mean_t, npix, dT = roi_stats(frame, (13, 9, 6, 5))
    ok1 = abs(mean_t - 33.0) < 1e-6 and npix == 30 and abs(dT - 0.0) < 1e-6
    print(f"  내부 ROI: mean={mean_t:.1f}(기대 33.0) pixels={npix}(기대 30) "
          f"dT={dT:.1f}(기대 0.0)  {'PASS' if ok1 else 'FAIL'}")

    # 프레임 경계 밖으로 튀어나가는 요청 — (30,22)~(36,27) 은 32x24 프레임에서 잘림
    _, npix2, _ = roi_stats(frame, (30, 22, 6, 5))
    ok2 = npix2 == 4
    print(f"  경계 클리핑: pixels={npix2}(기대 4, 2x2로 잘림)  {'PASS' if ok2 else 'FAIL'}")

    # 완전히 프레임 밖
    _, npix3, _ = roi_stats(frame, (40, 40, 4, 4))
    ok3 = npix3 == 0
    print(f"  완전 밖: pixels={npix3}(기대 0)  {'PASS' if ok3 else 'FAIL'}")


def test_pipeline():
    print("\n[2] SyntheticThermalCamera -> ThermalNostrilSource -> RespirationEstimator")
    print("    (호흡 대역 최소 윈도우 20초, 4Hz 캡처로 30초 수집)")
    ctx = ThermalContext(roi_found=True, roi_pixels=30, delta_t_contrast=3.0,
                         ffc_active=False, fps_jitter=0.02)
    dt = 0.25
    n_frames = int(30.0 / dt)

    for true_rpm in (10, 15, 22):
        cam = SyntheticThermalCamera(rpm=true_rpm, seed=int(true_rpm))
        src = ThermalNostrilSource(max_seconds=40, nominal_rate=1.0 / dt)
        est = RespirationEstimator([src], band=BAND_RR, fs=4.0)

        t_now = 0.0
        for _ in range(n_frames):
            frame = cam.read(dt)
            mean_t, _, _ = roi_stats(frame, cam.roi)
            src.update(frame.t, mean_t)
            t_now = frame.t

        bpm, conf, results = est.compute(ctx, t_now)
        err = abs(bpm - true_rpm) if np.isfinite(bpm) else float("inf")
        print(f"  true={true_rpm:2d} est={bpm:5.1f} err={err:4.1f} conf={conf:.2f}  "
              f"{'PASS' if err < 2.0 else 'FAIL'}")


def test_gates():
    print("\n[3] ThermalContext 게이트 — 열화상 고유 사유 3종이 실제로 막는가")
    base = dict(roi_found=True, roi_pixels=30, delta_t_contrast=3.0,
               ffc_active=False, fps_jitter=0.02)
    cases = [
        ("정상",             {}, "ok"),
        ("ROI 너무 작음",    {"roi_pixels": 2}, "roi_too_small"),
        ("온도 대비 부족",   {"delta_t_contrast": 0.2}, "low_thermal_contrast"),
        ("셔터(FFC) 보정중", {"ffc_active": True}, "ffc_active"),
        ("얼굴/ROI 없음",    {"roi_found": False}, "roi_missing"),
    ]
    all_ok = True
    for label, overrides, expected in cases:
        kw = {**base, **overrides}
        ctx = ThermalContext(**kw)
        # window 통과에 필요한 n_samples 를 넉넉히 준다 (min_window_sec=20s * fs=4Hz)
        reason = ctx.check(n_samples=200, fps=4.0, band=BAND_RR)
        ok = reason.value == expected
        all_ok &= ok
        print(f"  {label:<14s} -> {reason.value:<20s} (기대 {expected:<20s}) "
              f"{'PASS' if ok else 'FAIL'}")
    return all_ok


if __name__ == "__main__":
    print("=" * 70)
    print("TouchFree Vitals — MLX90640 캡처 계층 검증 (synthetic, 하드웨어 불필요)")
    print("=" * 70)
    test_roi_stats()
    test_pipeline()
    gates_ok = test_gates()
    print()
    print("=" * 70)
    print(f"SELFTEST RESULT: {'PASS' if gates_ok else 'FAIL'}")
    print("=" * 70)
