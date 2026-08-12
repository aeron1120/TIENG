"""실시간 졸음 모니터.

카메라 화면 위에 눈 ROI·홍채·동공을 그리고, 조사 노트의 세 채널을 같이 띄운다.

    A  눈꺼풀 운동학 — 깜빡임 지속시간과 AVR (Johns 계열)
    B  PERCLOS      — 눈이 80% 이상 감겨 있던 시간 비율
    C  동공 불안정   — PUI, 동공/홍채 비의 느린 흔들림

    python live_monitor.py        # q 로 종료

**판정은 미검증이다.** 임계값은 문헌에서 흔히 쓰는 값을 가져다 놓은 것이고 이 장비·
이 사람으로 보정한 적이 없다. 화면에 큰 글씨로 뜨는 '졸음'은 시연용 표시지 진단이
아니다. 진짜 판정을 하려면 KSS 라벨을 붙인 자체 데이터가 필요하다 (README).

세 채널을 따로 보여 주는 이유가 있다. 하나로 합친 점수만 띄우면 어느 채널이 죽어서
점수가 내려갔는지 알 수 없다. 특히 채널 C 는 가시광에서 대비가 안 나오면 통째로
무의미해지는데, 그때도 합산 점수는 멀쩡해 보인다.
"""

from __future__ import annotations

import argparse
import ctypes
import time
from collections import deque
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

import pupil
from run_plr import IRIS_A, IRIS_B, LIDS, ear_of, iris_circle, open_camera

HERE = Path(__file__).resolve().parent
MODEL = HERE / "face_landmarker.task"

CROP_PX = 240
CROP_HALF_IRIS = 2.0

PERCLOS_WINDOW_S = 60.0
PUI_WINDOW_S = 30.0
BLINK_WINDOW_S = 60.0

# PERCLOS 는 "80% 이상 감김"이 정의라 P80 이라 부른다.
CLOSED_FRAC = 0.80
# 눈 뜬 상태의 기준선. 최근 EAR 의 상위 분위수를 쓴다 — 최대값을 쓰면 한 번의
# 잡음 튐이 기준을 영구히 올려 버린다.
OPEN_PCTL = 90.0

# 판정 임계. 전부 문헌의 통상값이고 보정 전이다.
PERCLOS_WARN, PERCLOS_ALERT = 0.08, 0.15
BLINKDUR_WARN, BLINKDUR_ALERT = 0.30, 0.40  # 초
PUI_WARN, PUI_ALERT = 0.25, 0.40  # ratio 단위/분

FONT_CANDIDATES = ("C:/Windows/Fonts/malgun.ttf", "C:/Windows/Fonts/malgunsl.ttf")

# 레이아웃 기준 치수. 실제로는 화면 크기에 맞춘 배율을 곱해서 쓴다.
PANEL_W_BASE = 380
VIEW_H_BASE = 720
SCREEN_FILL = 0.86  # 화면 높이의 이만큼까지 쓴다

COL_BG = (22, 25, 30)
COL_OK = (150, 200, 90)
COL_WARN = (70, 165, 235)
COL_ALERT = (70, 80, 240)
COL_DIM = (120, 128, 140)
COL_TEXT = (232, 236, 242)
COL_IRIS = (190, 178, 87)
COL_PUPIL = (69, 154, 226)


def setup_dpi() -> None:
    """이 프로세스를 DPI 인식으로 만든다.

    안 하면 Windows 가 창을 통째로 비트맵 확대한다. 200% 배율 화면에서는 그림이
    2배로 늘어나 뿌옇게 뭉개지고, 창도 논리 해상도 기준이라 실제보다 훨씬 크게
    잡힌다. 인식을 켜면 물리 픽셀에 1:1 로 그려져 선명해진다.
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def screen_size() -> tuple[int, int]:
    """물리 픽셀 기준 화면 크기. setup_dpi() 뒤에 불러야 실제 값이 나온다."""
    try:
        u = ctypes.windll.user32
        return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))
    except Exception:
        return 1920, 1080


class Rolling:
    """(시각, 값) 을 시간 창으로만 들고 있는 큐."""

    def __init__(self, window_s: float) -> None:
        self.window_s = window_s
        self.buf: deque[tuple[float, float]] = deque()

    def add(self, t: float, v: float) -> None:
        self.buf.append((t, v))
        while self.buf and t - self.buf[0][0] > self.window_s:
            self.buf.popleft()

    def values(self) -> np.ndarray:
        return np.array([v for _, v in self.buf], np.float64)

    def times(self) -> np.ndarray:
        return np.array([t for t, _ in self.buf], np.float64)

    def span(self) -> float:
        return (self.buf[-1][0] - self.buf[0][0]) if len(self.buf) > 1 else 0.0


class BlinkDetector:
    """감김 비율에서 깜빡임을 잘라 내고 지속시간과 AVR 을 잰다.

    AVR(진폭/최대속도)은 Johns 계열의 핵심 지표지만, 30fps 에서 150ms 짜리 깜빡임은
    프레임 4~5장이라 최대속도를 제대로 못 잡는다. 그래서 값은 내되 화면에 '참고'로
    표시한다 — 이 한계가 조사 노트의 1번 리스크다.
    """

    ENTER, EXIT = 0.55, 0.35  # 히스테리시스. 하나뿐이면 경계에서 덜덜 떤다

    def __init__(self) -> None:
        self.in_blink = False
        self.t_start = 0.0
        self.samples: list[tuple[float, float]] = []
        self.events: deque[tuple[float, float, float]] = deque()  # (끝시각, 지속, AVR)

    def update(self, t: float, closure: float) -> None:
        if not self.in_blink:
            if closure >= self.ENTER:
                self.in_blink = True
                self.t_start = t
                self.samples = [(t, closure)]
            return

        self.samples.append((t, closure))
        if closure > self.EXIT:
            return

        dur = t - self.t_start
        self.in_blink = False
        if not (0.05 <= dur <= 1.2) or len(self.samples) < 3:  # 눈감기·잡음 배제
            return

        ts = np.array([s[0] for s in self.samples])
        cs = np.array([s[1] for s in self.samples])
        amp = float(cs.max() - cs[0])
        dt = np.diff(ts)
        vel = np.abs(np.diff(cs)) / np.maximum(dt, 1e-6)
        vmax = float(vel.max()) if vel.size else 0.0
        avr = amp / vmax if vmax > 1e-6 else float("nan")
        self.events.append((t, dur, avr))

    def recent(self, t: float) -> tuple[int, float, float]:
        while self.events and t - self.events[0][0] > BLINK_WINDOW_S:
            self.events.popleft()
        if not self.events:
            return 0, float("nan"), float("nan")
        durs = np.array([e[1] for e in self.events])
        avrs = np.array([e[2] for e in self.events])
        avrs = avrs[np.isfinite(avrs)]
        return len(self.events), float(durs.mean()), float(avrs.mean()) if avrs.size else float("nan")


def perclos(closures: Rolling) -> float:
    v = closures.values()
    return float((v >= CLOSED_FRAC).mean()) if v.size else float("nan")


def pui(ratios: Rolling) -> float:
    """동공 불안정 지수. 동공/홍채 비의 누적 변화량을 분당으로 환산한다.

    원 정의(PST)는 암실 11분·mm 단위지만 여기서는 창을 30초로 줄이고 정규화된 비를
    쓴다. 절대값을 문헌과 비교할 수는 없고, **같은 사람 안에서 시간에 따라 오르는지**
    만 본다 — 조사 노트가 지적한 대로 기저 크기가 아니라 변동이 신호이기 때문이다.
    """
    v, t = ratios.values(), ratios.times()
    if v.size < 20 or (t[-1] - t[0]) < 5.0:
        return float("nan")
    # 심박·잡음 성분을 걷어내고 느린 흔들림만 남긴다.
    k = max(int(round(v.size / (t[-1] - t[0]))), 3)
    sm = np.convolve(v, np.ones(k) / k, mode="valid")
    return float(np.abs(np.diff(sm)).sum() / (t[-1] - t[0]) * 60.0)


def level(value: float, warn: float, alert: float) -> int:
    """0 정상 / 1 주의 / 2 경고. 값이 없으면 -1."""
    if not np.isfinite(value):
        return -1
    return 2 if value >= alert else (1 if value >= warn else 0)


class Painter:
    """한글 텍스트용. cv2.putText 는 한글을 못 그려서 PIL 로 얹는다.

    호출부는 기준 크기(13/15/…)로 부르고, 화면 배율은 여기서 한 번만 곱한다.
    """

    BASE_SIZES = (13, 15, 17, 22, 40)

    def __init__(self, scale: float = 1.0) -> None:
        self.scale = scale
        self.font = None
        try:
            from PIL import ImageFont

            for path in FONT_CANDIDATES:
                if Path(path).exists():
                    self.font = {
                        s: ImageFont.truetype(path, max(int(round(s * scale)), 8))
                        for s in self.BASE_SIZES
                    }
                    break
        except ImportError:
            pass

    def text(self, img: np.ndarray, xy: tuple[int, int], s: str, size: int,
             color: tuple[int, int, int]) -> np.ndarray:
        if self.font is None:  # 한글 폰트가 없으면 영문 대체 없이 그냥 cv2 로
            cv2.putText(img, s, xy, cv2.FONT_HERSHEY_SIMPLEX,
                        size * self.scale / 34.0, color, 1, cv2.LINE_AA)
            return img
        from PIL import Image, ImageDraw

        pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        ImageDraw.Draw(pil).text(xy, s, font=self.font[size], fill=color[::-1])
        return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def draw_panel(p: Painter, h: int, w: int, m: dict) -> np.ndarray:
    def px(v: float) -> int:
        return int(round(v * p.scale))

    panel = np.full((h, w, 3), COL_BG, np.uint8)
    x = px(20)
    y = px(18)
    panel = p.text(panel, (x, y), "졸음 모니터", 22, COL_TEXT)
    y += px(34)
    panel = p.text(panel, (x, y), f"fps {m['fps']:.0f}   경과 {m['elapsed']:.0f}s", 13, COL_DIM)
    y += px(30)

    if m["warmup"] < 1.0:
        panel = p.text(panel, (x, y), f"창 채우는 중 {m['warmup'] * 100:.0f}%", 15, COL_WARN)
        y += px(8)
        cv2.rectangle(panel, (x, y + px(8)), (w - x, y + px(16)), (60, 66, 76), -1)
        cv2.rectangle(panel, (x, y + px(8)),
                      (x + int((w - 2 * x) * m["warmup"]), y + px(16)), COL_WARN, -1)
        y += px(34)
    y += px(6)

    rows = [
        ("A  눈꺼풀 운동학", [
            (f"깜빡임 {m['blink_n']}회/분", None),
            (f"평균 지속 {_fmt(m['blink_dur'], '{:.0f} ms', 1000)}", m["lv_dur"]),
            (f"AVR {_fmt(m['avr'], '{:.3f}')}  (30fps 한계, 참고)", None),
        ]),
        ("B  PERCLOS", [
            (f"P80 {_fmt(m['perclos'], '{:.1f} %', 100)}", m["lv_perclos"]),
            (f"현재 감김 {_fmt(m['closure'], '{:.0f} %', 100)}", None),
        ]),
        ("C  동공 불안정", [
            (f"PUI {_fmt(m['pui'], '{:.3f}')} /분", m["lv_pui"]),
            (f"동공/홍채 {_fmt(m['ratio'], '{:.3f}')}", None),
            (f"대비 d' {_fmt(m['dprime'], '{:.2f}')}"
             + ("  대비 부족 — 무의미" if m["low_contrast"] else ""),
             2 if m["low_contrast"] else None),
        ]),
    ]
    for title, items in rows:
        panel = p.text(panel, (20, y), title, 15, COL_TEXT)
        y += 24
        for label, lv in items:
            color = COL_DIM if lv is None else (COL_OK, COL_WARN, COL_ALERT)[lv] if lv >= 0 else COL_DIM
            panel = p.text(panel, (34, y), label, 15, color)
            y += 21
        y += 12

    verdict, vcolor, why = m["verdict"], m["verdict_color"], m["verdict_why"]
    box_y = h - 118
    cv2.rectangle(panel, (16, box_y), (PANEL_W - 16, h - 44), (34, 38, 45), -1)
    cv2.rectangle(panel, (16, box_y), (20, h - 44), vcolor, -1)
    panel = p.text(panel, (32, box_y + 12), verdict, 40, vcolor)
    panel = p.text(panel, (32, box_y + 62), why, 13, COL_DIM)
    panel = p.text(panel, (20, h - 32), "미검증 — 시연용 표시지 진단이 아니다", 13, COL_DIM)
    return panel


def _fmt(v: float, spec: str, mul: float = 1.0) -> str:
    return spec.format(v * mul) if np.isfinite(v) else "—"


def judge(lv_perclos: int, lv_dur: int, lv_pui: int, warm: float) -> tuple[str, tuple, str]:
    if warm < 1.0:
        return "대기", COL_DIM, "관측 창이 아직 안 찼다"
    live = [x for x in (lv_perclos, lv_dur, lv_pui) if x >= 0]
    if not live:
        return "측정 불가", COL_DIM, "쓸 수 있는 채널이 없다"
    if 2 in live:
        names = [n for n, x in zip(("PERCLOS", "깜빡임", "동공"),
                                   (lv_perclos, lv_dur, lv_pui)) if x == 2]
        return "졸음", COL_ALERT, "경고: " + ", ".join(names)
    if live.count(1) >= 2:
        return "주의", COL_WARN, "두 채널 이상이 주의 구간"
    if 1 in live:
        return "주의", COL_WARN, "한 채널이 주의 구간"
    return "각성", COL_OK, f"{len(live)}개 채널 정상"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--view", type=int, default=720, help="표시할 카메라 화면 폭")
    args = ap.parse_args()

    cap = open_camera(args.camera, args.width, args.height, manual_exposure=False)
    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODEL)),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
        )
    )
    painter = Painter()

    ear_hist = Rolling(20.0)
    closures = Rolling(PERCLOS_WINDOW_S)
    ratios = Rolling(PUI_WINDOW_S)
    blinks = BlinkDetector()
    dprimes = deque(maxlen=60)

    win = "졸음 모니터"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    t0 = time.perf_counter()
    prev = t0
    fps = 0.0
    print("q 로 종료. 얼굴이 화면에 보여야 지표가 돕니다.")

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                continue
            now = time.perf_counter()
            t = now - t0
            dt = now - prev
            prev = now
            fps = 0.9 * fps + 0.1 / max(dt, 1e-3) if fps else 1.0 / max(dt, 1e-3)

            frame = cv2.flip(frame, 1)  # 거울처럼 — 화면 보며 자세 잡기 편하게
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            res = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB,
                         data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), int(t * 1000)
            )

            closure = float("nan")
            ratio_now = float("nan")
            dp_now = float("nan")
            crops: list[np.ndarray] = []

            if res.face_landmarks:
                h, w = frame.shape[:2]
                pts = np.array([[p.x * w, p.y * h] for p in res.face_landmarks[0]], np.float32)
                ears, rts, dps = [], [], []

                for idx in (IRIS_A, IRIS_B):
                    cx, cy, r = iris_circle(pts, idx)
                    lid = min(LIDS, key=lambda L: abs(pts[list(L)][:, 0].mean() - cx))
                    ears.append(ear_of(pts, lid))

                    side = max(int(round(CROP_HALF_IRIS * 2 * r)), 16)
                    patch = cv2.getRectSubPix(gray, (side, side), (cx, cy))
                    crop = cv2.resize(patch, (CROP_PX, CROP_PX), interpolation=cv2.INTER_CUBIC)
                    scale = CROP_PX / side
                    s = pupil.measure(crop, CROP_PX / 2, CROP_PX / 2, r * scale)

                    # ROI 상자와 홍채·동공을 카메라 화면 위에 그대로 그린다.
                    x0, y0 = int(cx - side / 2), int(cy - side / 2)
                    cv2.rectangle(frame, (x0, y0), (x0 + side, y0 + side), (90, 96, 108), 1)
                    cv2.circle(frame, (int(cx), int(cy)), int(r), COL_IRIS, 1)
                    if s is not None:
                        rts.append(s.ratio)
                        dps.append(s.dprime)
                        fx = cx + (s.cx - CROP_PX / 2) / scale
                        fy = cy + (s.cy - CROP_PX / 2) / scale
                        cv2.ellipse(
                            frame,
                            ((float(fx), float(fy)),
                             (float(s.axis_major / scale), float(s.axis_minor / scale)),
                             float(s.angle)),
                            COL_PUPIL, 1,
                        )
                    crops.append(pupil.draw(cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR),
                                            CROP_PX / 2, CROP_PX / 2, r * scale, s))

                ear = float(np.mean(ears))
                ear_hist.add(t, ear)
                base = ear_hist.values()
                open_ear = float(np.percentile(base, OPEN_PCTL)) if base.size > 10 else ear
                closure = float(np.clip(1.0 - ear / max(open_ear, 1e-6), 0.0, 1.0))
                closures.add(t, closure)
                blinks.update(t, closure)
                if rts:
                    ratio_now = float(np.mean(rts))
                    dp_now = float(np.mean(dps))
                    dprimes.append(dp_now)
                    if dp_now >= 1.5:  # 대비가 안 나오면 PUI 에 넣지 않는다
                        ratios.add(t, ratio_now)

            n_blink, blink_dur, avr = blinks.recent(t)
            pc = perclos(closures)
            pu = pui(ratios)
            med_dp = float(np.median(dprimes)) if dprimes else float("nan")
            low_contrast = bool(np.isfinite(med_dp) and med_dp < 1.5)

            warm = min(closures.span() / PERCLOS_WINDOW_S, 1.0)
            lv_pc = level(pc, PERCLOS_WARN, PERCLOS_ALERT)
            lv_du = level(blink_dur, BLINKDUR_WARN, BLINKDUR_ALERT)
            lv_pu = -1 if low_contrast else level(pu, PUI_WARN, PUI_ALERT)
            verdict, vcolor, why = judge(lv_pc, lv_du, lv_pu, warm)

            scale_v = args.view / frame.shape[1]
            view = cv2.resize(frame, (args.view, int(frame.shape[0] * scale_v)))
            vh = view.shape[0]
            if crops:
                strip = np.hstack(crops)
                sw = min(strip.shape[1], args.view)
                view[vh - 120:vh, 0:sw] = cv2.resize(strip, (sw, 120))

            panel = draw_panel(painter, vh, {
                "fps": fps, "elapsed": t, "warmup": warm,
                "blink_n": n_blink, "blink_dur": blink_dur, "avr": avr, "lv_dur": lv_du,
                "perclos": pc, "closure": closure, "lv_perclos": lv_pc,
                "pui": pu, "ratio": ratio_now, "dprime": med_dp,
                "low_contrast": low_contrast, "lv_pui": lv_pu,
                "verdict": verdict, "verdict_color": vcolor, "verdict_why": why,
            })
            cv2.imshow(win, np.hstack([view, panel]))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        cap.release()
        landmarker.close()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
