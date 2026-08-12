"""PLR 양성 대조 실험 러너.

화면을 어둡게/밝게 번갈아 띄워 동공을 강제로 움직이고, 그게 웹캠에 잡히는지
기록한다. 대광반사는 동공이 내는 신호 중 가장 큰 것이라 **이게 안 보이면 각성이나
스트레스가 만드는 훨씬 작은 변화는 볼 필요도 없다.** 반대로 잘 보이면 그 진폭이
잡음 대비 몇 배인지가 다음 단계의 예산이 된다.

여기 있는 얼굴→눈 크롭 코드는 웹캠 단계 전용 발판이다. 안경 근접 카메라에는
얼굴이 없어 FaceMesh 가 통째로 못 쓰인다. 이식되는 것은 pupil.py 뿐이다.

    python run_plr.py                 # 90초 프로토콜 실행 → out/plr_*.csv
    python run_plr.py --duration 30   # 짧게
    python run_plr.py --camera 1      # 다른 카메라

실행 중 q 를 누르면 중단하고 거기까지 저장한다.
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

import pupil

HERE = Path(__file__).resolve().parent
MODEL = HERE / "face_landmarker.task"
OUT = HERE / "out"

# --- 자극 프로토콜 --------------------------------------------------------- #
# 어둠에 적응시킨 뒤 밝기 계단을 반복한다. 적응 구간이 필요한 이유는, 시작하자마자
# 밝히면 첫 수축이 '적응 중 자연 확장'과 섞여 진폭을 못 재기 때문이다.
ADAPT_S = 15.0
BRIGHT_S = 5.0
DARK_S = 10.0

# --- 눈 크롭 --------------------------------------------------------------- #
# 홍채 반지름의 2배를 반폭으로 잡는다. 눈꺼풀과 눈구석이 들어올 만큼은 넓고,
# 눈썹까지 끌어오지는 않는 크기다.
CROP_HALF_IRIS = 2.0
CROP_PX = 240  # 크롭을 항상 이 크기로 맞춘다 → 크롭 안 홍채 반지름은 늘 60px

# MediaPipe FaceLandmarker(478점)의 홍채 랜드마크. 각 눈 5점 = 중심 1 + 경계 4.
# 중심 인덱스를 믿지 않고 경계 4점의 평균을 쓴다 — 좌/우 명명 규약이 버전마다
# 흔들려도 이러면 영향을 받지 않는다.
IRIS_A = (469, 470, 471, 472)
IRIS_B = (474, 475, 476, 477)
# EAR 용 눈꺼풀. (왼눈구석, 오른눈구석, 위, 아래). 어느 홍채와 짝인지는
# 하드코딩하지 않고 실행 중 거리로 정한다.
LIDS = ((33, 133, 159, 145), (362, 263, 386, 374))

BLINK_EAR = 0.15

CSV_FIELDS = [
    "t_s", "frame", "dt_ms", "stim_level", "phase", "cycle", "eye",
    "face_ok", "ear", "blink", "frame_mean",
    "iris_r_src_px", "pupil_ok", "ratio", "r_eq_crop_px",
    "axis_major", "axis_minor", "dprime", "mean_pupil", "mean_iris",
    "specular_frac", "conf",
]


def stimulus(t: float, cycles: int) -> tuple[float, str, int]:
    """경과 시간 → (밝기 0/1, 구간 이름, 사이클 번호)."""
    if t < ADAPT_S:
        return 0.0, "adapt", -1
    u = t - ADAPT_S
    period = BRIGHT_S + DARK_S
    cyc = int(u // period)
    if cyc >= cycles:
        return 0.0, "done", cyc
    return (1.0, "bright", cyc) if (u - cyc * period) < BRIGHT_S else (0.0, "dark", cyc)


def open_camera(
    index: int, width: int, height: int, manual_exposure: bool = True
) -> cv2.VideoCapture:
    """카메라를 연다. PLR 실험에서는 자동 노출·화이트밸런스를 끈다.

    끄는 이유가 이 실험의 핵심 전제다. 화면을 밝히면 얼굴도 같이 밝아지는데, 자동
    노출이 살아 있으면 카메라가 그걸 되돌리려고 게인을 낮춘다. 그러면 동공이 실제로
    수축했는지, 카메라가 노출을 줄인 것인지 영영 구분할 수 없다.

    반대로 실시간 모니터(live_monitor.py)는 자극을 주지 않으므로 자동 노출이 오히려
    낫다 — 방 밝기가 바뀌어도 얼굴이 계속 보여야 한다. manual_exposure=False 로 연다.
    """
    cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        raise SystemExit(f"카메라 {index} 를 열 수 없다")

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if manual_exposure:
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)  # DSHOW 에서 0.25 = 수동
        cap.set(cv2.CAP_PROP_EXPOSURE, -6)
        cap.set(cv2.CAP_PROP_AUTO_WB, 0)

    print("[카메라] 요청 후 실제 값")
    for name, prop in (
        ("width", cv2.CAP_PROP_FRAME_WIDTH),
        ("height", cv2.CAP_PROP_FRAME_HEIGHT),
        ("fps", cv2.CAP_PROP_FPS),
        ("auto_exposure", cv2.CAP_PROP_AUTO_EXPOSURE),
        ("exposure", cv2.CAP_PROP_EXPOSURE),
        ("auto_wb", cv2.CAP_PROP_AUTO_WB),
    ):
        print(f"         {name:14s} {cap.get(prop)}")
    print("  자동 노출이 안 꺼졌으면 frame_mean 이 자극을 따라 출렁인다 — 분석에서 경고한다.")
    return cap


def iris_circle(pts: np.ndarray, idx: tuple[int, ...]) -> tuple[float, float, float]:
    """경계 4점 → (중심x, 중심y, 반지름). 반지름은 중심까지 거리의 평균."""
    p = pts[list(idx)]
    cx, cy = float(p[:, 0].mean()), float(p[:, 1].mean())
    r = float(np.hypot(p[:, 0] - cx, p[:, 1] - cy).mean())
    return cx, cy, r


def ear_of(pts: np.ndarray, lid: tuple[int, int, int, int]) -> float:
    left, right, top, bottom = (pts[i] for i in lid)
    span = float(np.hypot(*(left - right)))
    return float(np.hypot(*(top - bottom)) / span) if span > 1e-6 else 0.0


def build_canvas(size: tuple[int, int], level: float) -> np.ndarray:
    v = 255 if level > 0.5 else 0
    return np.full((size[1], size[0], 3), v, np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--cycles", type=int, default=5)
    ap.add_argument("--duration", type=float, default=None, help="초. 기본은 프로토콜 전체")
    ap.add_argument("--no-preview", action="store_true", help="자극 화면에 미리보기를 안 겹친다")
    args = ap.parse_args()

    if not MODEL.exists():
        print(f"모델이 없다: {MODEL}", file=sys.stderr)
        return 1

    total = args.duration or (ADAPT_S + args.cycles * (BRIGHT_S + DARK_S))
    OUT.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = OUT / f"plr_{stamp}.csv"

    cap = open_camera(args.camera, args.width, args.height)
    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODEL)),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
        )
    )

    win = "PLR"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
    canvas_size = (1920, 1080)

    print(f"\n프로토콜 {total:.0f}초 — 적응 {ADAPT_S:.0f}s → (밝게 {BRIGHT_S:.0f}s / "
          f"어둡게 {DARK_S:.0f}s) × {args.cycles}")
    print("화면을 보고 가만히 계세요. 중단은 q.\n")

    fh = csv_path.open("w", newline="", encoding="utf-8")
    writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
    writer.writeheader()

    t0 = time.perf_counter()
    prev = t0
    frame_i = 0
    warned_count = False

    try:
        while True:
            now = time.perf_counter()
            t = now - t0
            if t >= total:
                break

            ok, frame = cap.read()
            if not ok:
                continue
            dt_ms = (now - prev) * 1000.0
            prev = now
            frame_i += 1

            level, phase, cyc = stimulus(t, args.cycles)
            gray_full = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            frame_mean = float(gray_full.mean())

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(t * 1000)
            )
            face_ok = bool(result.face_landmarks)

            base = {
                "t_s": f"{t:.4f}", "frame": frame_i, "dt_ms": f"{dt_ms:.2f}",
                "stim_level": level, "phase": phase, "cycle": cyc,
                "face_ok": int(face_ok), "frame_mean": f"{frame_mean:.2f}",
            }

            crops: list[np.ndarray] = []
            if not face_ok:
                for eye in ("A", "B"):
                    writer.writerow({**base, "eye": eye, "pupil_ok": 0})
            else:
                h, w = frame.shape[:2]
                lms = result.face_landmarks[0]
                if len(lms) < 478 and not warned_count:
                    print(f"경고: 랜드마크가 {len(lms)}개다. 홍채(468~477)가 없으면 이 실험은 "
                          f"성립하지 않는다.", file=sys.stderr)
                    warned_count = True
                pts = np.array([[p.x * w, p.y * h] for p in lms], np.float32)

                for eye, idx in (("A", IRIS_A), ("B", IRIS_B)):
                    cx, cy, r = iris_circle(pts, idx)
                    lid = min(LIDS, key=lambda L: abs(pts[list(L)][:, 0].mean() - cx))
                    ear = ear_of(pts, lid)

                    side = max(int(round(CROP_HALF_IRIS * 2 * r)), 16)
                    patch = cv2.getRectSubPix(gray_full, (side, side), (cx, cy))
                    crop = cv2.resize(patch, (CROP_PX, CROP_PX), interpolation=cv2.INTER_CUBIC)
                    scale = CROP_PX / side
                    s = pupil.measure(crop, CROP_PX / 2, CROP_PX / 2, r * scale)

                    row = {
                        **base, "eye": eye, "ear": f"{ear:.4f}",
                        "blink": int(ear < BLINK_EAR), "iris_r_src_px": f"{r:.2f}",
                        "pupil_ok": int(s is not None),
                    }
                    if s is not None:
                        row.update({
                            "ratio": f"{s.ratio:.5f}", "r_eq_crop_px": f"{s.r_eq:.3f}",
                            "axis_major": f"{s.axis_major:.3f}",
                            "axis_minor": f"{s.axis_minor:.3f}",
                            "dprime": f"{s.dprime:.4f}",
                            "mean_pupil": f"{s.mean_pupil:.2f}",
                            "mean_iris": f"{s.mean_iris:.2f}",
                            "specular_frac": f"{s.specular_frac:.4f}",
                            "conf": f"{s.confidence:.4f}",
                        })
                    writer.writerow(row)

                    if not args.no_preview:
                        vis = pupil.draw(cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR),
                                         CROP_PX / 2, CROP_PX / 2, r * scale, s)
                        txt = f"{eye} r={r:.0f}px"
                        if s is not None:
                            txt += f" ratio={s.ratio:.3f} d'={s.dprime:.1f}"
                        cv2.putText(vis, txt, (6, CROP_PX - 8), cv2.FONT_HERSHEY_SIMPLEX,
                                    0.42, (255, 255, 255), 1, cv2.LINE_AA)
                        crops.append(vis)

            canvas = build_canvas(canvas_size, level)
            if crops and not args.no_preview:
                strip = np.hstack(crops)
                canvas[0:strip.shape[0], 0:strip.shape[1]] = strip
            hud = f"{t:5.1f}/{total:.0f}s  {phase}  fps={1000.0 / max(dt_ms, 1e-3):4.1f}"
            cv2.putText(canvas, hud, (12, CROP_PX + 34), cv2.FONT_HERSHEY_SIMPLEX,
                        0.7, (128, 128, 128), 2, cv2.LINE_AA)
            cv2.imshow(win, canvas)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("중단됨 — 여기까지 저장한다.")
                break
    finally:
        fh.close()
        cap.release()
        landmarker.close()
        cv2.destroyAllWindows()

    print(f"\n저장: {csv_path}  ({frame_i} 프레임)")
    print(f"판정:  python analyze.py {csv_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
