"""눈꺼풀 기반 졸음 지표 어댑터 (PERCLOS + 깜빡임).

카메라를 직접 열지 않는다. rPPG 어댑터가 이미 잡고 있는 프레임을 FrameSource 로
받아 쓴다 (core/adapters/base.py). 같은 장치를 두 번 열면 Windows 에서는 실패하고,
Linux 에서 열리더라도 두 스트림이 노출을 서로 흔들어 심박까지 나빠진다.

두 채널을 낸다.

    PERCLOS   눈이 80% 이상 감겨 있던 시간 비율. 1994년 Wierwille 이래 가장 널리
              검증된 수동적 졸음 지표다. 다만 중등도 졸음에서는 신뢰도가 떨어진다고
              알려져 있어 단독 판정에는 쓰지 않는다.
    깜빡임    지속시간. 졸리면 눈을 감고 있는 시간이 길어진다.

동공(PUI/IPA)은 여기 없다. 동공은 홍채와의 **밝기 차이**로 경계를 찾아야 하는데
짙은 갈색 홍채는 가시광에서 그 차이가 거의 없다. 850nm 적외선 조명이 있어야 눈
색깔과 무관하게 대비가 생긴다. 하드웨어가 오면 별도 어댑터로 붙인다.

읽는 주기(1Hz)와 보는 주기가 다르다는 점이 중요하다. 눈깜빡임은 100~400ms 라
1초에 한 번 프레임을 보면 통째로 놓친다. 그래서 rPPG 와 같은 구조를 쓴다 —
전용 스레드가 프레임을 계속 보며 통계를 쌓고, read() 는 그 통계를 집어 갈 뿐이다.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import structlog

from api.schemas import Metric, Mode, State, server_now
from core.adapters.base import FrameSource, OverlayTarget, SensorAdapter

log = structlog.get_logger(__name__)

# 모델 경로는 cwd 가 아니라 저장소 기준이다. 서버를 어디서 띄우든 같은 파일을 봐야
# 한다 — 기기 설정이 아니라 코드에 딸린 자산이기 때문이다 (api/main.py 의 WEB_DIST 와 같다).
_ROOT = Path(__file__).resolve().parents[2]

POLL_HZ = 60.0  # 프레임 폴링. 공급자의 실제 fps 보다 넉넉히 잡고 중복은 버린다
FACE_DETECT_SEC = 0.2  # 매 프레임 검출은 Pi 에서 FPS 를 깎는다
FACE_RETRY_SEC = 0.1  # 놓친 동안에는 더 자주 다시 찾는다
# 못 찾은 채 이만큼 지나야 "얼굴이 없다"로 본다. 검출이 실패한 것과 사람이 나간
# 것은 다르고, 그때마다 상자를 버리면 표본이 거의 안 쌓인다.
FACE_LOST_SEC = 2.0

YUNET_SCORE = 0.6  # 이보다 확신이 낮은 얼굴은 버린다
YUNET_NMS = 0.3

# 눈 상자 크기. 두 눈 사이 거리(IOD)에 비례해서 잡는다 — 얼굴 크기가 곧 거리라
# 픽셀로 고정하면 가까이 오면 눈이 상자를 넘치고 멀어지면 눈썹까지 들어온다.
# 눈꺼풀이 오르내리는 범위를 담아야 하므로 눈구멍 자체(IOD 의 약 0.16)보다 넉넉히 준다.
EYE_BOX_W = 0.45
EYE_BOX_H = 0.32

# PERCLOS 의 정의가 "80% 이상 감김"이라 P80 이라 부른다.
CLOSED_FRAC = 0.80
# 눈 뜬 상태의 기준선. 최근 개안도의 상위 분위수를 쓴다 — 최대값을 쓰면 한 번의
# 잡음 튐이 기준을 영구히 올려 버려 그 뒤 전부 '감김'으로 읽힌다.
OPEN_PCTL = 90.0
OPEN_MIN_SAMPLES = 60

# 깜빡임 판정 히스테리시스. 임계가 하나면 경계에서 덜덜 떨며 한 번 감은 것이
# 수십 번으로 세어진다.
BLINK_ENTER, BLINK_EXIT = 0.55, 0.35
BLINK_MIN_S, BLINK_MAX_S = 0.05, 1.20

# 최근 프레임 중 눈을 실제로 본 비율. 문턱이 하나면 실측에서 0.45~0.99 사이를
# 오가며 값과 보류가 번갈아 떠서, 화면이 1초마다 깜빡인다. rPPG 의 게이트와 같은
# 방식으로 진입/이탈을 벌려 둔다.
MIN_TRACK_RATE = 0.45
KEEP_TRACK_RATE = 0.30

# 미리보기에 눈 상자를 그릴 색 (BGR). rPPG 의 볼 ROI 가 금색(따뜻한 색)이라
# 대비되도록 청록으로 둔다 — 같은 화면에 있으면 어느 쪽이 무엇인지 바로 갈려야 한다.
EYE_BOX_COLOR = (200, 190, 90)


class DrowsinessAdapter(SensorAdapter):
    provides = ["perclos", "blink_dur", "drowsiness"]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        source: str = "rppg",
        model: str = "models/face_detection_yunet_2023mar.onnx",
        window_s: float = 60.0,
        perclos_warn: float = 8.0,
        perclos_alert: float = 15.0,
        blink_warn_ms: float = 300.0,
        blink_alert_ms: float = 400.0,
    ) -> None:
        super().__init__(id, mode)
        # FrameConsumer 계약. registry 가 이 이름으로 공급자를 찾아 붙여 준다.
        self.source_id = source
        self.model_path = Path(model)
        self.window_s = window_s
        self.perclos_warn = perclos_warn
        self.perclos_alert = perclos_alert
        self.blink_warn_ms = blink_warn_ms
        self.blink_alert_ms = blink_alert_ms

        self._frames: FrameSource | None = None
        self._overlay: OverlayTarget | None = None
        self._attached = False
        self._detector: Any = None
        self._input_size: tuple[int, int] | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        # 아래는 전부 _lock 으로 보호한다. 워커가 쓰고 read() 가 읽는다.
        self._closures: deque[tuple[float, float]] = deque()
        self._opens: deque[float] = deque(maxlen=600)
        self._seen: deque[tuple[float, bool]] = deque()  # (시각, 눈을 봤나)
        self._blinks: deque[tuple[float, float]] = deque()  # (끝시각, 지속 s)
        # 표본을 모으기 시작한 시각. 진행률을 버퍼의 앞뒤 간격으로 재면 안 된다 —
        # 창 밖 표본을 버리는 이상 그 간격은 창 길이에 영원히 못 닿고, 진행률이
        # 0.999 에서 멈춰 값이 끝내 안 나온다.
        self._since: float | None = None
        self._fault: str | None = None
        # 지금 값을 내고 있는가. 게이트 히스테리시스용이라 read() 만 만진다.
        self._producing = False

    # --- FrameConsumer ------------------------------------------------------ #

    def attach_frames(self, source: FrameSource | None) -> None:
        self._frames = source
        self._attached = source is not None
        # 프레임을 준 쪽이 미리보기도 만든다면 눈 상자를 거기 얹는다. 못 얹어도
        # 측정에는 아무 지장이 없으므로 조용히 넘어간다.
        self._overlay = source if isinstance(source, OverlayTarget) else None

    # --- 수명주기 ----------------------------------------------------------- #

    async def start(self) -> None:
        path = self.model_path if self.model_path.is_absolute() else _ROOT / self.model_path
        if not path.exists():
            raise RuntimeError(f"YuNet 모델이 없다: {path}")
        # 입력 크기는 첫 프레임에서 setInputSize 로 다시 맞춘다.
        self._detector = cv2.FaceDetectorYN.create(
            str(path), "", (320, 320), YUNET_SCORE, YUNET_NMS
        )

        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name=f"drowsiness-{self.id}", daemon=True
        )
        self._thread.start()

    async def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    # --- 지표 --------------------------------------------------------------- #

    async def read(self) -> list[Metric]:
        now = time.monotonic()
        with self._lock:
            if self._fault is not None:
                raise RuntimeError(self._fault)  # registry 가 state=error 로 강등한다
            self._trim(now)
            closures = [c for _, c in self._closures]
            since = self._since
            seen = [ok for _, ok in self._seen]
            blinks = [d for _, d in self._blinks]
            attached = self._attached

        if self.window_s <= 0:
            progress = 1.0
        elif since is None:
            progress = 0.0
        else:
            progress = min((now - since) / self.window_s, 1.0)
        track = float(np.mean(seen)) if seen else 0.0

        if not attached:
            return self._blank("no_adapter", None, 0.0)
        if not seen:
            # 공급자는 붙었는데 프레임이 아직 없다. 카메라가 뜨는 중일 수 있다.
            return self._blank("low_quality", 0.0, 0.0)
        floor = KEEP_TRACK_RATE if self._producing else MIN_TRACK_RATE
        if track < floor:
            # 얼굴이나 눈이 안 잡힌다. 값을 지어내지 않는다 (README §0-4).
            self._producing = False
            return self._blank("low_quality", track, progress)
        self._producing = True

        perclos = float(np.mean([c >= CLOSED_FRAC for c in closures])) * 100.0 if closures else None
        blink_ms = float(np.mean(blinks)) * 1000.0 if blinks else None

        if progress < 1.0:
            # 창이 덜 찼다. PERCLOS 는 창 전체를 봐야 의미가 있으므로 보류한다.
            return self._blank("low_quality", track, progress)

        verdict = self._judge(perclos, blink_ms)
        return [
            self._metric("perclos", perclos, "%", "ok", track, progress),
            self._metric(
                "blink_dur", blink_ms, "ms",
                "ok" if blink_ms is not None else "low_quality", track, progress,
            ),
            self._metric("drowsiness", verdict, None, "ok", track, progress),
        ]

    def _judge(self, perclos: float | None, blink_ms: float | None) -> str:
        """두 채널을 합친다. 임계는 config 에서 온다 (README §0-5).

        문헌의 통상값을 기본으로 뒀을 뿐 이 장비로 보정한 적이 없다. 발표에서 이
        숫자를 근거로 쓰려면 KSS 라벨을 붙인 자체 데이터가 먼저 필요하다.
        """
        levels = []
        if perclos is not None:
            levels.append(_step(perclos, self.perclos_warn, self.perclos_alert))
        if blink_ms is not None:
            levels.append(_step(blink_ms, self.blink_warn_ms, self.blink_alert_ms))
        if not levels:
            return "unknown"
        if 2 in levels:
            return "drowsy"
        return "warning" if 1 in levels else "awake"

    def _blank(self, state: State, confidence: float | None, progress: float) -> list[Metric]:
        return [self._metric(k, None, None, state, confidence, progress) for k in self.provides]

    def _metric(
        self, key: str, value: float | str | None, unit: str | None,
        state: State, confidence: float | None, progress: float,
    ) -> Metric:
        return Metric(
            key=key,
            value=value,
            unit=unit,
            source=self.id,
            mode=self.mode,
            state=state,
            confidence=None if confidence is None else round(confidence, 3),
            progress=round(progress, 3),
            ts=server_now(),
        )

    # --- 워커 스레드 -------------------------------------------------------- #

    def _loop(self) -> None:
        period = 1.0 / POLL_HZ
        last_ts = -1.0
        eyes: list[tuple[int, int, int, int]] = []  # 원본 프레임 좌표
        have_face = False
        last_detect = 0.0
        last_ok = 0.0
        in_blink = False
        blink_start = 0.0
        blink_peak = 0.0

        while not self._stop.is_set():
            src = self._frames
            got = src.latest_frame() if src is not None else None
            if got is None:
                time.sleep(period)
                continue
            ts, frame = got
            if ts <= last_ts:  # 같은 프레임을 두 번 세지 않는다
                time.sleep(period)
                continue
            last_ts = ts

            bgr = np.asarray(frame)
            try:
                gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            except Exception as exc:
                with self._lock:
                    self._fault = f"프레임을 해석할 수 없다: {exc}"
                return

            # 못 찾았다고 바로 상자를 버리지 않는다. 검출이 한 프레임 실패한 것과
            # 사람이 자리를 뜬 것은 다르고, 그때마다 버리면 표본이 거의 안 쌓인다.
            interval = FACE_DETECT_SEC if have_face else FACE_RETRY_SEC
            if ts - last_detect >= interval:
                last_detect = ts
                try:
                    found = self._detect_eyes(bgr)
                except Exception as exc:
                    with self._lock:
                        self._fault = f"얼굴 검출이 실패했다: {exc}"
                    return
                if found is not None:
                    eyes, have_face, last_ok = found, True, ts
                elif have_face and ts - last_ok > FACE_LOST_SEC:
                    eyes, have_face = [], False

            openness: float | None = None
            if eyes:
                vals = [
                    v
                    for v in (_openness(gray[y:y + h, x:x + w]) for x, y, w, h in eyes)
                    if v is not None
                ]
                if vals:
                    openness = float(np.mean(vals))

            # 지금 무엇을 보고 있는지 미리보기에 그린다. 눈 상자가 엉뚱한 데 가 있으면
            # 값이 왜 이상한지 화면에서 바로 보인다 — 얼굴 ROI 를 그리는 이유와 같다.
            if self._overlay is not None:
                self._overlay.set_overlay(self.id, list(eyes), EYE_BOX_COLOR)

            with self._lock:
                self._seen.append((ts, openness is not None))
                if openness is not None:
                    self._opens.append(openness)
                    base = (
                        float(np.percentile(self._opens, OPEN_PCTL))
                        if len(self._opens) >= OPEN_MIN_SAMPLES
                        else None
                    )
                    if base is not None and base > 1e-6:
                        closure = float(np.clip(1.0 - openness / base, 0.0, 1.0))
                        self._closures.append((ts, closure))
                        if self._since is None:
                            self._since = ts
                        # 깜빡임 절단. 워커 스레드만 이 상태를 만지므로 락 밖 변수를 쓴다.
                        if not in_blink and closure >= BLINK_ENTER:
                            in_blink, blink_start, blink_peak = True, ts, closure
                        elif in_blink:
                            blink_peak = max(blink_peak, closure)
                            if closure <= BLINK_EXIT:
                                dur = ts - blink_start
                                in_blink = False
                                if BLINK_MIN_S <= dur <= BLINK_MAX_S:
                                    self._blinks.append((ts, dur))
                self._trim(ts)

            time.sleep(period)

    def _detect_eyes(self, bgr: np.ndarray) -> list[tuple[int, int, int, int]] | None:
        """YuNet 으로 얼굴을 찾아 두 눈 상자를 원본 좌표로 돌려준다. 못 찾으면 None.

        Haar 눈 캐스케이드를 걷어낸 이유가 여기 있다. 캐스케이드는 '뜬 눈'을 찾도록
        학습돼 있어 **눈을 감으면 검출에 실패**한다. PERCLOS 는 감긴 시간의 비율인데
        하필 감았을 때 표본이 사라지니, 지표가 낮은 쪽으로 체계적으로 편향된다.
        YuNet 은 검출이 아니라 랜드마크 회귀라 감아도 눈 위치를 내놓는다.
        """
        h, w = bgr.shape[:2]
        if self._input_size != (w, h):
            self._detector.setInputSize((w, h))
            self._input_size = (w, h)

        _, faces = self._detector.detect(bgr)
        if faces is None or len(faces) == 0:
            return None
        # 가장 큰 얼굴 하나. 뒤로 지나가는 사람이 아니라 카메라 앞에 앉은 사람을 본다.
        face = max(faces, key=lambda b: float(b[2]) * float(b[3]))

        # YuNet 랜드마크 5점: [4:6] 오른눈, [6:8] 왼눈, [8:10] 코, [10:14] 입 양끝
        right, left = face[4:6], face[6:8]
        iod = float(np.hypot(left[0] - right[0], left[1] - right[1]))
        # 너무 멀면 눈꺼풀을 가를 해상도가 안 나온다. 억지로 재느니 표본을 버린다.
        if iod < 40.0:
            return None

        bw = max(int(round(iod * EYE_BOX_W)), 8)
        bh = max(int(round(iod * EYE_BOX_H)), 6)
        boxes: list[tuple[int, int, int, int]] = []
        for cx, cy in (right, left):
            x, y = int(round(float(cx) - bw / 2)), int(round(float(cy) - bh / 2))
            # 화면 밖으로 걸치면 버린다. 잘린 상자에서 잰 높이는 감은 것처럼 보인다.
            if x < 0 or y < 0 or x + bw > w or y + bh > h:
                continue
            boxes.append((x, y, bw, bh))
        return boxes or None

    def _trim(self, now: float) -> None:
        """창 밖으로 나간 표본을 버린다. 호출자가 _lock 을 들고 있어야 한다."""
        for buf in (self._closures, self._seen, self._blinks):
            while buf and now - buf[0][0] > self.window_s:
                buf.popleft()
        # 표본이 통째로 비면 처음부터 다시 모은다. 사람이 오래 자리를 비운 뒤
        # 돌아왔는데 진행률만 100% 로 남아 있으면, 창이 비었는데도 값을 낸다.
        if not self._closures:
            self._since = None


def _step(value: float, warn: float, alert: float) -> int:
    """0 정상 / 1 주의 / 2 경고."""
    return 2 if value >= alert else 1 if value >= warn else 0


def _openness(eye: np.ndarray) -> float | None:
    """눈 상자 하나의 개안도 (0~1 근처). 못 재면 None.

    랜드마크가 없으므로 눈꺼풀 좌표를 직접 얻을 수 없다. 대신 눈 구멍이 주변 피부보다
    어둡다는 성질을 쓴다 — 어두운 덩어리의 **세로 높이**가 곧 눈이 벌어진 정도다.
    감으면 그 덩어리가 속눈썹 한 줄로 납작해진다.

    절대값은 사람·조명마다 다르므로 의미가 없다. 호출자가 자기 기준선으로 정규화한다.
    """
    if eye.size == 0:
        return None
    h, w = eye.shape[:2]
    if h < 8 or w < 8:
        return None

    eq = cv2.equalizeHist(eye)
    thr = float(np.percentile(eq, 30.0))
    dark = (eq <= thr).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, kernel)

    n, _, stats, cents = cv2.connectedComponentsWithStats(dark, connectivity=8)
    best, best_d = None, None
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 0.02 * h * w:
            continue
        # 세로로 상자 한가운데에 가까운 덩어리를 고른다. 가장 큰 것을 고르면 눈썹이나
        # 그림자가 잡힌다.
        d = abs(float(cents[i][1]) - h / 2.0)
        if best_d is None or d < best_d:
            best, best_d = i, d
    if best is None:
        return None
    return float(stats[best, cv2.CC_STAT_HEIGHT]) / float(h)


