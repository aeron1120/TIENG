"""
v2 데모 파이프라인에 confidence 모듈을 붙이는 배선 예제 (노트북 웹캠 기준).

지난 논의에서 짚은 웹캠 함정 세 가지를 여기서 처리한다:
  (1) 오토 노출/화이트밸런스 OFF  — 안 끄면 카메라가 우리 신호를 지운다
  (2) 실제 타임스탬프 기록 + 리샘플링 — fps=30 가정은 BPM을 통째로 틀리게 만든다
  (3) 얼굴 ROI와 상체 ROI를 분리 — 심박과 호흡은 보는 곳이 다르다

실행:  python3 integrate_webcam.py              # 측정만
       python3 integrate_webcam.py --log run.csv  # 캘리브레이션용 로깅
"""

import argparse
import csv
import sys
import time
from collections import deque

# Windows 콘솔 기본 인코딩(cp949)에서는 한글 출력이 UnicodeEncodeError를 낸다.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")

import cv2
import numpy as np

from confidence import (
    BAND_HR, BAND_RR, FrameContext, VitalEstimator, Calibration,
    DecisionPolicy, AlertPolicy, fuse,
)

FPS_NOMINAL = 30.0
HR_WIN_SEC, RR_WIN_SEC = 10.0, 30.0


# ---------------------------------------------------------------------------
# (1) 카메라 — 자동 보정을 끄는 것이 가장 중요하다
# ---------------------------------------------------------------------------

def open_camera(index=0, width=640, height=480):
    cap = cv2.VideoCapture(index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, FPS_NOMINAL)

    # ★ 오토 노출 OFF. 백엔드마다 매직넘버가 다르다(V4L2: 1=manual, 3=auto).
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)
    cap.set(cv2.CAP_PROP_AUTO_WB, 0)
    cap.set(cv2.CAP_PROP_EXPOSURE, -6)      # 환경에 맞춰 조정
    # 설정이 먹었는지 반드시 확인할 것 — 조용히 무시하는 드라이버가 많다
    print(f"[cam] auto_exposure={cap.get(cv2.CAP_PROP_AUTO_EXPOSURE)} "
          f"auto_wb={cap.get(cv2.CAP_PROP_AUTO_WB)}")
    return cap


# ---------------------------------------------------------------------------
# (2) 타임스탬프 기반 균일 리샘플링
# ---------------------------------------------------------------------------

class TimedBuffer:
    """(시각, 값) 쌍을 모아 균일 간격으로 리샘플링해 돌려준다."""

    def __init__(self, seconds, fps=FPS_NOMINAL):
        self.seconds, self.fps = seconds, fps
        self.buf = deque(maxlen=int(seconds * fps * 2))

    def push(self, t, v):
        self.buf.append((t, float(v)))

    def window(self):
        if len(self.buf) < 10:
            return None, 0.0
        ts = np.array([b[0] for b in self.buf])
        vs = np.array([b[1] for b in self.buf])
        ts -= ts[0]
        if ts[-1] < self.seconds * 0.9:
            return None, 0.0
        grid = np.arange(0, ts[-1], 1.0 / self.fps)
        jitter = float(np.std(np.diff(ts)) / max(np.mean(np.diff(ts)), 1e-9))
        return np.interp(grid, ts, vs), jitter


# ---------------------------------------------------------------------------
# (3) ROI 추출 — 심박은 얼굴, 호흡은 상체
# ---------------------------------------------------------------------------

CASCADE = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml")


def extract(frame, prev_gray):
    """얼굴 ROI의 RGB 평균(→POS 입력)과 상체 수직 움직임(→호흡)을 뽑는다."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = CASCADE.detectMultiScale(gray, 1.2, 5, minSize=(80, 80))

    ctx = FrameContext()
    rgb_mean, chest_motion = None, 0.0

    if len(faces) == 0:
        ctx.roi_found = False
    else:
        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
        # 이마: 얼굴 상단 25~45% 구간
        fx, fy = x + int(w * 0.25), y + int(h * 0.15)
        fw, fh = int(w * 0.5), int(h * 0.25)
        roi = frame[fy:fy + fh, fx:fx + fw]
        if roi.size:
            rgb_mean = roi.reshape(-1, 3).mean(axis=0)[::-1]   # BGR→RGB
            g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            ctx.roi_mean_intensity = float(g.mean())
            ctx.roi_saturated_frac = float((g >= 250).mean())
            ctx.roi_dark_frac = float((g <= 5).mean())

        # 상체: 얼굴 아래쪽 밴드. 노트북 웹캠은 가까워서 프레임을 벗어나기 쉽다.
        cy = min(y + int(h * 1.6), frame.shape[0] - 1)
        ch = min(int(h * 1.2), frame.shape[0] - cy)
        if ch > 20 and prev_gray is not None:
            cx, cw = max(x - int(w * 0.4), 0), min(int(w * 1.8), frame.shape[1] - x)
            a = prev_gray[cy:cy + ch, cx:cx + cw]
            b = gray[cy:cy + ch, cx:cx + cw]
            if a.shape == b.shape and a.size:
                flow = cv2.calcOpticalFlowFarneback(
                    a, b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
                chest_motion = float(np.mean(flow[..., 1]))   # 수직 성분
        ctx.motion_magnitude = abs(chest_motion) * 10.0

    return ctx, rgb_mean, chest_motion, gray


def pos_projection(rgb_window):
    """POS (Wang 2017). v2 데모에 이미 있다면 그쪽 구현을 쓰면 된다."""
    C = np.asarray(rgb_window, float).T           # 3 x N
    mu = C.mean(axis=1, keepdims=True)
    Cn = C / np.where(mu == 0, 1, mu)
    S = np.array([[0, 1, -1], [-2, 1, 1]]) @ Cn
    return S[0] + (np.std(S[0]) / (np.std(S[1]) + 1e-12)) * S[1]


# ---------------------------------------------------------------------------
# 메인 루프
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", help="캘리브레이션용 CSV 경로")
    ap.add_argument("--cal-hr", default="calibration_HR.json")
    ap.add_argument("--cal-rr", default="calibration_RR.json")
    args = ap.parse_args()

    def load(p):
        try:
            return Calibration.load(p)
        except Exception:
            print(f"[cal] {p} 없음 — 캘리브레이션 없이 진행 (expected_mae=None)")
            return None

    cal_hr, cal_rr = load(args.cal_hr), load(args.cal_rr)

    est_hr = VitalEstimator(BAND_HR, FPS_NOMINAL, cal_hr)
    est_rr = VitalEstimator(BAND_RR, FPS_NOMINAL, cal_rr)

    # 캘리브레이션이 있으면 목표 오차로부터 임계값을 역산한다(눈대중 제거)
    pol_hr = (DecisionPolicy.from_calibration(cal_hr, 3.0, 6.0, 12.0)
              if cal_hr else DecisionPolicy())
    pol_rr = (DecisionPolicy.from_calibration(cal_rr, 1.5, 3.0, 6.0)
              if cal_rr else DecisionPolicy())

    alert_hr = AlertPolicy(lo=45, hi=110, min_conf=0.75, n_consecutive=5)
    alert_rr = AlertPolicy(lo=8,  hi=25,  min_conf=0.75, n_consecutive=5)

    rgb_buf = TimedBuffer(HR_WIN_SEC)
    chest_buf = TimedBuffer(RR_WIN_SEC)
    rgb_raw = deque(maxlen=int(HR_WIN_SEC * FPS_NOMINAL * 2))

    cap = open_camera()
    prev_gray = None
    writer = fh = None
    if args.log:
        fh = open(args.log, "w", newline="")
        writer = csv.writer(fh)
        writer.writerow(["t", "hr_bpm", "hr_conf", "hr_state", "hr_reason",
                         "rr_bpm", "rr_conf", "rr_state", "rr_reason",
                         "ref_hr"])   # ref_hr: 펄스옥시미터 값을 나중에 채운다

    t0 = time.time()
    last_report = 0.0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t = time.time() - t0

            ctx, rgb, chest, gray = extract(frame, prev_gray)
            prev_gray = gray
            if rgb is not None:
                rgb_raw.append((t, rgb))
                chest_buf.push(t, chest)

            if t - last_report < 1.0:      # 1초마다 갱신(겹치는 슬라이딩 윈도우)
                continue
            last_report = t

            # --- HR ---
            r_hr = None
            if len(rgb_raw) > int(HR_WIN_SEC * FPS_NOMINAL * 0.8):
                ts = np.array([a for a, _ in rgb_raw])
                arr = np.array([b for _, b in rgb_raw])
                grid = np.arange(ts[0], ts[-1], 1.0 / FPS_NOMINAL)
                res = np.stack([np.interp(grid, ts, arr[:, i]) for i in range(3)], 1)
                ctx.fps_jitter = float(np.std(np.diff(ts)) / max(np.mean(np.diff(ts)), 1e-9))
                r_hr = est_hr.update(pos_projection(res), ctx, t)
            d_hr = pol_hr.decide(r_hr) if r_hr else None

            # --- RR ---
            w_rr, jitter = chest_buf.window()
            r_rr = None
            if w_rr is not None:
                ctx.fps_jitter = jitter
                r_rr = est_rr.update(w_rr, ctx, t)
            d_rr = pol_rr.decide(r_rr) if r_rr else None

            # --- 표시 ---
            if d_hr:
                a = alert_hr.update(r_hr, t)
                print(f"[{t:6.1f}s] HR {d_hr.text:>10s} ({d_hr.state.label_ko}) "
                      f"conf={r_hr.confidence:.2f}"
                      + (f"  ⚠ {a.detail}" if a.detail else ""))
            if d_rr:
                a = alert_rr.update(r_rr, t)
                print(f"          RR {d_rr.text:>10s} ({d_rr.state.label_ko}) "
                      f"conf={r_rr.confidence:.2f}"
                      + (f"  ⚠ {a.detail}" if a.detail else ""))

            if writer and (r_hr or r_rr):
                writer.writerow([
                    f"{t:.2f}",
                    f"{r_hr.bpm:.2f}" if r_hr and r_hr.ok else "",
                    f"{r_hr.confidence:.4f}" if r_hr else "",
                    d_hr.state.value if d_hr else "", r_hr.reason.value if r_hr else "",
                    f"{r_rr.bpm:.2f}" if r_rr and r_rr.ok else "",
                    f"{r_rr.confidence:.4f}" if r_rr else "",
                    d_rr.state.value if d_rr else "", r_rr.reason.value if r_rr else "",
                    "",
                ])
                fh.flush()
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        if fh:
            fh.close()
            print(f"\n로그 저장: {args.log}")
            print("→ ref_hr 열에 펄스옥시미터 값을 채운 뒤 Calibration.fit() 실행")


if __name__ == "__main__":
    main()
