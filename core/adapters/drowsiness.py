"""눈꺼풀 기반 졸음 조기 경보 어댑터.

목표는 "졸고 있다"가 아니라 **졸음 직전**을 잡는 것이다. 그래서 지표 선택이
흔한 구성과 다르다.

카메라를 직접 열지 않는다. rPPG 어댑터가 이미 잡고 있는 프레임을 FrameSource 로
받아 쓴다 (core/adapters/base.py). 같은 장치를 두 번 열면 Windows 에서는 실패하고,
Linux 에서 열리더라도 두 스트림이 노출을 서로 흔들어 심박까지 나빠진다.

세 채널을 가중 합산한다.

    재개안 지연  눈을 다시 뜨는 데 걸리는 시간. 가장 이른 신호다 — 졸릴 때
                 느려지는 것은 감는 동작이 아니라 뜨는 동작이라고 보고돼 있다.
    깜빡임 지속  같은 상위군. 감고 있는 시간이 길어진다.
    PERCLOS      눈이 80% 이상 감겨 있던 시간 비율. 가장 널리 검증됐지만 **후행
                 지표**다. 리뷰가 "detects fatigue too late, fails to detect
                 participants that are drowsy with eyes wide open" 이라고 적는다.
                 그래서 무게를 낮추고 혼자서는 경고를 못 내게 했다.

앞의 두 채널은 절대 임계가 아니라 **그 사람의 평소 대비 증가율**로 본다. 개인차가
크다는 것이 문헌의 공통 지적이고, 실측에서도 같은 사람의 깜빡임이 194~465ms 로
흔들렸다. 그래서 처음 baseline_s 동안을 각성 상태로 보고 기준선을 만든다.

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
# 감김도를 뜬 상태와 감은 상태 **사이**로 정규화한다. 개안도 원값은 "눈 상자 안
# 어두운 덩어리의 높이 비율"이라 완전히 감아도 0 이 되지 않는다 — 속눈썹과 주름이
# 남기 때문이다. 실측에서 개안도가 0.262~0.833 이었고, 뜬 상태만 기준으로 삼으면
# 감김도가 최대 0.607 까지밖에 안 올라 P80 에 영원히 못 닿았다 (PERCLOS 가 늘 0%).
#
# 최대·최소 대신 분위수를 쓰는 이유는 한 번의 잡음 튐이 기준을 영구히 망치기 때문이다.
OPEN_PCTL = 90.0
CLOSED_PCTL = 2.0
OPEN_MIN_SAMPLES = 60
# 뜬 상태와 감은 상태가 이만큼은 벌어져야 감김도를 믿는다. 한 번도 안 감으면 둘이
# 붙어 버리는데, 그때 정규화하면 미세한 잡음이 곧바로 '감김'으로 증폭된다.
MIN_CLOSURE_SPAN = 0.10

# 깜빡임 판정 히스테리시스. 임계가 하나면 경계에서 덜덜 떨며 한 번 감은 것이
# 수십 번으로 세어진다.
BLINK_ENTER, BLINK_EXIT = 0.55, 0.35
BLINK_MIN_S, BLINK_MAX_S = 0.05, 1.20

# --- 개인 기준선 ---------------------------------------------------------- #
# 문헌이 공통으로 지적하는 것이 개인차가 크다는 점이다. 실제로 같은 사람에게서도
# 깜빡임이 194~465ms 로 흔들렸다. 절대 임계(400ms 등)로는 누구는 늘 졸린 사람이
# 되고 누구는 영영 안 걸린다. 그래서 "평소의 그 사람" 대비 변화율로 본다.
BASELINE_S = 90.0  # 처음 이만큼을 각성 상태로 보고 기준선을 만든다
BASELINE_MIN_BLINKS = 8  # 이보다 적으면 기준선을 믿지 않는다

# --- 채널 가중 ------------------------------------------------------------ #
# 조기 경보가 목적이라 PERCLOS 를 주력에서 내렸다. PERCLOS 는 "눈이 오래 감겨
# 있었다"를 재는데, 그 상태는 이미 늦다 — 리뷰가 "detects fatigue too late,
# fails to detect participants that are drowsy with eyes wide open" 이라고 적는다.
#
# 대신 눈꺼풀 운동의 질을 본다. 졸릴 때 느려지는 것은 눈을 감는 동작이 아니라
# **다시 뜨는 동작**이라, 재개안 지연이 가장 이른 신호다.
#
# 앞의 셋은 전부 같은 개안도 시계열에서 나온다 — 형태(재개안·지속)와 시간(빈도)로
# 갈리지만 뿌리가 같아 상관이 높다. 그래서 개안도 측정이 흔들리면 셋이 같이
# 흔들린다. 머리 자세를 넣은 이유가 이것이다: **눈꺼풀과 무관한 유일한 채널**이라,
# 융합이 실제로 실패 모드를 나눠 갖게 만든다.
W_REOPEN = 0.35  # 재개안 지연 — 가장 이른 신호
W_DURATION = 0.25  # 깜빡임 지속시간 — 같은 상위군
W_BLINKRATE = 0.15  # 깜빡임 빈도 — 문헌의 상위 4개에 blink interval 이 있다
W_HEAD = 0.15  # 고개 떨굼 — 눈꺼풀과 독립
W_PERCLOS = 0.10  # 후행·확인용. 혼자서는 경고를 못 낸다

# 각 채널이 0 -> 1 로 차오르는 구간. PERCLOS 만 절대값이고 나머지는 기준선 대비다.
REOPEN_RISE = 0.60  # 재개안이 기준선보다 60% 길어지면 만점
DURATION_RISE = 0.50
# 빈도는 오르내리기를 둘 다 한다. 졸음 초기에 늘었다가 심해지면 줄어드는 것으로
# 알려져 있어, 방향이 아니라 **기준선에서 얼마나 벗어났나**로 본다.
BLINKRATE_SHIFT = 0.60
HEAD_DROP_RISE = 0.12  # 고개가 기준선보다 이만큼 내려가면 만점 (자세 비율 기준)
PERCLOS_LO, PERCLOS_HI = 4.0, 15.0

SCORE_WARN, SCORE_ALERT = 30.0, 60.0

# --- 추세 ----------------------------------------------------------------- #
# 조기 경보에서는 "지금 높다"보다 "빠르게 오르고 있다"가 더 쓸모 있을 때가 많다.
# 문헌에도 주행 시간의 누적 효과를 넣은 모델이 나온다 — 같은 값이라도 오래 몰수록
# 위험하다. 여기서는 점수의 기울기를 따로 내보내고, 판정이 그것도 같이 본다.
TREND_WINDOW_S = 180.0
TREND_MIN_SAMPLES = 20
TREND_WARN = 6.0  # 분당 이만큼 오르면 아직 임계 아래여도 주의로 본다

# 최근 프레임 중 눈을 실제로 본 비율. 문턱이 하나면 실측에서 0.45~0.99 사이를
# 오가며 값과 보류가 번갈아 떠서, 화면이 1초마다 깜빡인다. rPPG 의 게이트와 같은
# 방식으로 진입/이탈을 벌려 둔다.
MIN_TRACK_RATE = 0.45
KEEP_TRACK_RATE = 0.30

# 미리보기에 눈 상자를 그릴 색 (BGR). rPPG 의 볼 ROI 가 금색(따뜻한 색)이라
# 대비되도록 청록으로 둔다 — 같은 화면에 있으면 어느 쪽이 무엇인지 바로 갈려야 한다.
EYE_BOX_COLOR = (200, 190, 90)


class DrowsinessAdapter(SensorAdapter):
    provides = [
        "drowsy_score",
        "drowsy_trend",
        "reopen_ms",
        "blink_dur",
        "blink_rate",
        "head_drop",
        "perclos",
        "drowsiness",
    ]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        source: str = "rppg",
        model: str = "models/face_detection_yunet_2023mar.onnx",
        window_s: float = 60.0,
        baseline_s: float = BASELINE_S,
        score_warn: float = SCORE_WARN,
        score_alert: float = SCORE_ALERT,
    ) -> None:
        super().__init__(id, mode)
        # FrameConsumer 계약. registry 가 이 이름으로 공급자를 찾아 붙여 준다.
        self.source_id = source
        self.model_path = Path(model)
        self.window_s = window_s
        self.baseline_s = baseline_s
        self.score_warn = score_warn
        self.score_alert = score_alert

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
        self._opens: deque[float] = deque(maxlen=1800)
        # 뜬/감은 기준값 (hi, 폭). 한 번 잡으면 들고 있는다 — 아래 설명 참고.
        self._closure_ref: tuple[float, float] | None = None
        self._seen: deque[tuple[float, bool]] = deque()  # (시각, 눈을 봤나)
        self._blinks: deque[tuple[float, float, float]] = deque()  # (끝시각, 지속 s, 재개안 s)
        # 개인 기준선. 각성 상태로 보는 처음 baseline_s 동안 모아 중앙값을 낸다.
        self._base_samples: list[tuple[float, float]] = []
        self._base_started: float | None = None
        self._base_until: float | None = None
        self._base_dur: float | None = None
        self._base_reopen: float | None = None
        self._base_rate: float | None = None  # 분당 깜빡임
        self._base_pitch: float | None = None  # 머리 자세 기준
        # 머리 자세 (시각, pitch). 눈꺼풀과 무관한 유일한 채널이다.
        self._poses: deque[tuple[float, float]] = deque()
        # 점수 이력. 추세(기울기)를 내려고 들고 있는다.
        self._scores: deque[tuple[float, float]] = deque()
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
            blinks = [(d, r) for _, d, r in self._blinks]
            poses = [p for _, p in self._poses]
            base_dur, base_reopen = self._base_dur, self._base_reopen
            base_rate, base_pitch = self._base_rate, self._base_pitch
            base_until = self._base_until
            attached = self._attached

        track = float(np.mean(seen)) if seen else 0.0
        progress = self._progress(now, since, base_until, base_dur is not None)

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
        dur_ms = float(np.mean([d for d, _ in blinks])) * 1000.0 if blinks else None
        reopen_ms = float(np.mean([r for _, r in blinks])) * 1000.0 if blinks else None
        rate = len(blinks) / self.window_s * 60.0 if self.window_s > 0 else None
        # 고개가 기준선보다 얼마나 내려갔나. 든 것은 세지 않는다 — 졸음의 징후는
        # 떨구는 쪽이고, 위를 보는 것은 그냥 다른 데를 보는 것이다.
        head_drop = None
        if poses and base_pitch is not None and abs(base_pitch) > 1e-6:
            head_drop = max((base_pitch - float(np.mean(poses))) / abs(base_pitch), 0.0) * 100.0

        # 창이 덜 찼거나 기준선이 아직 없으면 판정하지 않는다. 기준선 없이 절대
        # 임계로 재면 개인차가 그대로 오진이 된다 (BASELINE_S 주석).
        if progress < 1.0 or base_dur is None or base_reopen is None:
            return self._blank("low_quality", track, progress)

        score = self._score(
            perclos, dur_ms, reopen_ms, rate, head_drop, base_dur, base_reopen, base_rate
        )
        with self._lock:
            self._scores.append((now, score))
            history = list(self._scores)
        trend = _slope_per_min(history)

        # 아직 임계 아래여도 빠르게 오르는 중이면 주의로 올린다. 조기 경보의 목적이
        # "높다"를 알리는 게 아니라 "오르고 있다"를 먼저 알리는 것이기 때문이다.
        rising = trend is not None and trend >= TREND_WARN
        if score >= self.score_alert:
            verdict = "drowsy"
        elif score >= self.score_warn or (rising and score >= self.score_warn * 0.6):
            verdict = "warning"
        else:
            verdict = "awake"

        ok = "ok"
        blink_state: State = ok if dur_ms is not None else "low_quality"
        head_state: State = ok if head_drop is not None else "low_quality"
        return [
            self._metric("drowsy_score", round(score, 1), None, ok, track, progress),
            self._metric(
                "drowsy_trend",
                None if trend is None else round(trend, 2),
                "/분",
                ok if trend is not None else "low_quality",
                track,
                progress,
            ),
            self._metric("reopen_ms", reopen_ms, "ms", blink_state, track, progress),
            self._metric("blink_dur", dur_ms, "ms", blink_state, track, progress),
            self._metric("blink_rate", rate, "/분", ok, track, progress),
            self._metric("head_drop", head_drop, "%", head_state, track, progress),
            self._metric("perclos", perclos, "%", ok, track, progress),
            self._metric("drowsiness", verdict, None, ok, track, progress),
        ]

    def _progress(
        self, now: float, since: float | None, base_until: float | None, base_ready: bool
    ) -> float:
        """관측 창과 기준선 학습 중 느린 쪽. 둘 다 끝나야 판정이 나온다."""
        if self.window_s <= 0:
            window = 1.0
        elif since is None:
            window = 0.0
        else:
            window = min((now - since) / self.window_s, 1.0)

        if base_ready:
            baseline = 1.0
        elif base_until is None:
            baseline = 0.0
        else:
            span = max(self.baseline_s, 1e-6)
            # 0.99 에서 멈춘다. 기준선이 안 끝났는데 100% 로 보이면 "다 됐는데 왜
            # 값이 없냐"가 된다 — 진행률은 끝났다는 뜻이어야 한다.
            baseline = min(max(1.0 - (base_until - now) / span, 0.0), 0.99)
        return min(window, baseline)

    def _score(
        self,
        perclos: float | None,
        dur_ms: float | None,
        reopen_ms: float | None,
        rate: float | None,
        head_drop: float | None,
        base_dur: float,
        base_reopen: float,
        base_rate: float | None,
    ) -> float:
        """0~100. 조기 신호에 무게를 싣고 PERCLOS 는 뒤로 뺀다.

        가중치의 근거는 상단 주석에 있다. 요지는 둘이다 — PERCLOS 는 후행 지표라
        졸음 **직전**을 못 잡고, 눈꺼풀에서 나오는 채널끼리는 상관이 높아 아무리
        여럿 더해도 실패 모드가 나뉘지 않는다. 그래서 머리 자세를 넣었다.

        PERCLOS 만 절대값이고 나머지는 그 사람의 평소 대비로 넣는다.

        채널이 없으면 그 몫은 0 으로 둔다. 가중치를 남은 채널에 다시 나눠 주지
        않는 게 중요하다 — 그러면 PERCLOS 하나로도 만점이 나와서, 후행 지표만 보고
        "조기 경보"를 냈다고 말하게 된다.
        """
        score = 0.0
        if reopen_ms is not None and base_reopen > 1e-6:
            score += W_REOPEN * _ramp((reopen_ms / 1000.0) / base_reopen - 1.0, REOPEN_RISE)
        if dur_ms is not None and base_dur > 1e-6:
            score += W_DURATION * _ramp((dur_ms / 1000.0) / base_dur - 1.0, DURATION_RISE)
        if rate is not None and base_rate is not None and base_rate > 1e-6:
            # 빈도는 방향이 정해져 있지 않다. 초기에 늘었다가 심해지면 줄어드는
            # 것으로 알려져 있어, 어느 쪽이든 벗어난 정도만 본다.
            score += W_BLINKRATE * _ramp(abs(rate / base_rate - 1.0), BLINKRATE_SHIFT)
        if head_drop is not None:
            score += W_HEAD * _ramp(head_drop / 100.0, HEAD_DROP_RISE)
        if perclos is not None:
            score += W_PERCLOS * _ramp(perclos - PERCLOS_LO, PERCLOS_HI - PERCLOS_LO)
        return score * 100.0

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
        peak_t = 0.0

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
                    eyes, pitch = found
                    have_face, last_ok = True, ts
                    with self._lock:
                        self._poses.append((ts, pitch))
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
                    # 눈을 한동안 안 감으면 최근 표본에 '감은 상태'가 없어져 폭이
                    # 좁아진다. 그때 산출을 멈추면 창이 통째로 비고 기준선까지
                    # 초기화된다 — 가만히 잘 뜨고 있을수록 시스템이 죽는 셈이다.
                    # 그래서 한 번 잡은 기준값은 새 것이 유효할 때까지 들고 있는다.
                    if len(self._opens) >= OPEN_MIN_SAMPLES:
                        hi = float(np.percentile(self._opens, OPEN_PCTL))
                        lo = float(np.percentile(self._opens, CLOSED_PCTL))
                        if hi - lo >= MIN_CLOSURE_SPAN:
                            self._closure_ref = (hi, hi - lo)
                    if self._closure_ref is not None:
                        hi, width = self._closure_ref
                        closure = float(np.clip((hi - openness) / width, 0.0, 1.0))
                        self._closures.append((ts, closure))
                        if self._since is None:
                            self._since = ts
                        # 깜빡임 절단. 워커 스레드만 이 상태를 만지므로 락 밖 변수를 쓴다.
                        #
                        # 감김과 재개안을 나눠서 잰다. 졸릴 때 느려지는 것은 눈을
                        # 감는 동작이 아니라 다시 뜨는 동작이라, 하나로 합치면 정작
                        # 신호가 있는 쪽이 평평한 쪽에 희석된다.
                        if not in_blink and closure >= BLINK_ENTER:
                            in_blink, blink_start, blink_peak = True, ts, closure
                            peak_t = ts
                        elif in_blink:
                            if closure > blink_peak:
                                blink_peak, peak_t = closure, ts
                            if closure <= BLINK_EXIT:
                                dur = ts - blink_start
                                reopen = ts - peak_t
                                in_blink = False
                                if BLINK_MIN_S <= dur <= BLINK_MAX_S:
                                    self._blinks.append((ts, dur, reopen))
                                    self._feed_baseline(ts, dur, reopen)
                self._trim(ts)

            time.sleep(period)

    def _detect_eyes(
        self, bgr: np.ndarray
    ) -> tuple[list[tuple[int, int, int, int]], float] | None:
        """YuNet 으로 얼굴을 찾아 (눈 상자들, 머리 pitch) 를 돌려준다. 못 찾으면 None.

        pitch 는 눈-입 사이에서 코가 놓인 위치의 비율이다. 크기·위치에 불변이라
        거리나 화면 안 위치가 변해도 흔들리지 않고, 고개를 숙이면 코가 상대적으로
        위로 투영돼 값이 **작아진다**. 랜드마크 5점만으로 얻을 수 있어 모델을 더
        얹지 않아도 된다.

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
        nose, mouth_r, mouth_l = face[8:10], face[10:12], face[12:14]
        eye_y = (float(right[1]) + float(left[1])) / 2.0
        mouth_y = (float(mouth_r[1]) + float(mouth_l[1])) / 2.0
        pitch = (float(nose[1]) - eye_y) / max(mouth_y - eye_y, 1e-6)
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
        return (boxes, pitch) if boxes else None

    def _feed_baseline(self, ts: float, dur: float, reopen: float) -> None:
        """각성 상태로 보는 처음 구간의 깜빡임을 모아 그 사람의 평소를 만든다.

        호출자가 _lock 을 들고 있어야 한다. 중앙값을 쓰는 이유는 하품이나 눈비비기
        한 번이 평균을 통째로 끌어올리기 때문이다.
        """
        if self._base_dur is not None:
            return
        if self._base_until is None:
            self._base_started = ts
            self._base_until = ts + self.baseline_s
        if ts <= self._base_until:
            self._base_samples.append((dur, reopen))
            return
        if len(self._base_samples) < BASELINE_MIN_BLINKS:
            # 표본이 모자라면 더 기다린다. 서너 번 깜빡인 걸로 만든 기준선은
            # 그 뒤 모든 판정을 틀리게 만든다.
            self._base_until = ts + self.baseline_s * 0.5
            self._base_samples.append((dur, reopen))
            return
        self._base_dur = float(np.median([d for d, _ in self._base_samples]))
        self._base_reopen = float(np.median([r for _, r in self._base_samples]))
        elapsed = max(ts - (self._base_started or ts), 1e-6)
        self._base_rate = len(self._base_samples) / elapsed * 60.0
        # 자세 기준은 지금 창에 있는 것으로 잡는다. 기준선 구간이 창보다 길어
        # 앞부분은 이미 버려졌지만, 각성 상태인 것은 마찬가지다.
        self._base_pitch = float(np.median([p for _, p in self._poses])) if self._poses else None
        log.info(
            "drowsiness.baseline",
            adapter=self.id,
            blinks=len(self._base_samples),
            dur_ms=round(self._base_dur * 1000, 1),
            reopen_ms=round(self._base_reopen * 1000, 1),
            rate_per_min=round(self._base_rate, 1),
            pitch=None if self._base_pitch is None else round(self._base_pitch, 3),
        )

    def _trim(self, now: float) -> None:
        """창 밖으로 나간 표본을 버린다. 호출자가 _lock 을 들고 있어야 한다."""
        for buf in (self._closures, self._seen, self._blinks, self._poses):
            while buf and now - buf[0][0] > self.window_s:
                buf.popleft()
        while self._scores and now - self._scores[0][0] > TREND_WINDOW_S:
            self._scores.popleft()
        # 표본이 통째로 비면 처음부터 다시 모은다. 사람이 오래 자리를 비운 뒤
        # 돌아왔는데 진행률만 100% 로 남아 있으면, 창이 비었는데도 값을 낸다.
        #
        # 기준선도 같이 버린다. 창이 통째로 빌 만큼 자리를 비웠다면 다른 사람이
        # 앉았을 수도 있고, 남의 평소로 재는 것은 안 재느니만 못하다.
        if not self._closures:
            self._since = None
            self._closure_ref = None
            self._base_samples.clear()
            self._base_started = None
            self._base_until = None
            self._base_dur = None
            self._base_reopen = None
            self._base_rate = None
            self._base_pitch = None
            self._scores.clear()


def _slope_per_min(history: list[tuple[float, float]]) -> float | None:
    """점수 이력의 기울기 (점/분). 표본이 적으면 None.

    최소제곱 직선 하나다. 창이 3분이라 순간의 튐은 눌리고, 지속적으로 오르는
    흐름만 남는다.
    """
    if len(history) < TREND_MIN_SAMPLES:
        return None
    t = np.array([x for x, _ in history], dtype=np.float64)
    y = np.array([v for _, v in history], dtype=np.float64)
    span = t[-1] - t[0]
    if span < 1e-6:
        return None
    t = t - t[0]
    slope = float(np.polyfit(t, y, 1)[0])  # 점/초
    return slope * 60.0


def _ramp(value: float, span: float) -> float:
    """0 에서 span 까지 0~1 로 차오르는 경사. 밖으로 나가면 잘린다."""
    if span <= 1e-9:
        return 0.0
    return float(min(max(value / span, 0.0), 1.0))


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


