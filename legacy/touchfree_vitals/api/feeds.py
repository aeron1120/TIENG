"""브라우저 카메라에서 올라온 지표. 세션마다 하나씩.

프레임은 여기 오지 않는다. 브라우저가 얼굴 ROI 의 평균 RGB 세 숫자까지 줄인 뒤에
그것만 보낸다 — 영상이 기기 밖으로 나가지 않는다는 규칙(README §1 비목표)이 서버
위치가 바뀌어도 그대로 성립해야 하기 때문이다.

계산은 카메라 어댑터와 같은 것을 쓴다 (core/pulse.py). 같은 신호에 같은 답이 나와야
"웹에서 잰 값"과 "파이에서 잰 값"을 같은 근거로 말할 수 있다.

세션마다 추정기를 따로 두는 이유는 그것이 상태를 들고 있기 때문이다. 하나를 돌려
쓰면 철수의 이전 값이 영희의 점프 판정 기준이 된다.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Iterator, Mapping, Sequence

import numpy as np
import structlog

from api.schemas import Metric, Mode
from core.pulse import WINDOW_SEC, HrEstimator

log = structlog.get_logger(__name__)

# 마지막으로 표본이 올라온 뒤 이만큼 지나면 그 세션의 값을 내리다.
#
# 안 내리면 카메라를 끄거나 창을 닫은 뒤에도 마지막 심박이 화면에 그대로 남는다.
# 멎은 숫자가 실시간인 척 남아 있는 것은 값을 지어내는 것과 같다 (README §0-4).
STALE_AFTER_S = 3.0

# 한 번에 받는 표본 수 상한. 30fps 로 1초 치를 보내는 것을 전제로 하되, 창을 통째로
# 다시 보내는 경우까지는 받아 준다. 이보다 크면 한 요청이 이벤트 루프를 오래 잡는다.
MAX_BATCH = 600


class Feed:
    """한 세션의 창. 표본을 받아 두었다가 심박 하나를 낸다."""

    def __init__(self, source: str, mode: Mode, gate: float, window_s: float = WINDOW_SEC) -> None:
        self.estimator = HrEstimator(source=source, mode=mode, gate=gate)
        self.window_s = window_s
        self.touched = time.monotonic()

        self._times: deque[float] = deque()
        self._rgbs: deque[tuple[float, float, float]] = deque()
        self._metric: Metric | None = None

    def push(
        self,
        samples: Sequence[tuple[float, float, float, float]],
        jitter_norm: float,
        skin_ratio: float,
        brightness: float,
    ) -> Metric:
        """표본을 넣고 지금 낼 수 있는 값을 돌려준다. 블로킹이다 (scipy)."""
        self.touched = time.monotonic()

        for t, r, g, b in samples:
            # 시각이 뒤로 가는 표본은 버린다. 창을 시간순으로 두지 않으면 재샘플링이
            # 엉키고, 브라우저 시계는 탭이 백그라운드로 가면 실제로 흔들린다.
            if self._times and t <= self._times[-1]:
                continue
            self._times.append(t)
            self._rgbs.append((r, g, b))

        while self._times and (self._times[-1] - self._times[0]) > self.window_s:
            self._times.popleft()
            self._rgbs.popleft()

        # 점프 가드에 벽시계 대신 표본 시각을 준다.
        #
        # 가드가 재려는 것은 "직전 값 이후 얼마나 지났는가"다. 카메라는 프레임을 실시간
        # 으로 넣으므로 둘이 같지만, 여기서는 브라우저가 묶음을 몰아 보낼 수 있다 —
        # 그러면 12초 치가 밀리초 만에 들어와 정상적인 변화가 전부 점프로 거부된다.
        # 표본 시각을 쓰면 보내는 속도와 무관하게 신호가 흐른 만큼으로 잰다.
        self._metric = self.estimator.estimate(
            np.asarray(self._times, dtype=np.float64),
            np.asarray(self._rgbs, dtype=np.float64),
            jitter_norm,
            skin_ratio,
            brightness,
            now=self._times[-1] if self._times else None,
        )
        return self._metric

    def metrics(self) -> list[Metric]:
        return [] if self._metric is None else [self._metric]


class Feeds(Mapping[str, list[Metric]]):
    """세션 토큰 -> 그 세션이 낸 지표.

    Mapping 인 이유는 보내는 쪽(api/ws.py)이 이것을 그냥 사전처럼 읽기 때문이다.
    거기서는 값이 어디서 왔는지 알 필요가 없고, 알면 그 파일이 카메라를 알게 된다.

    읽을 때 오래된 것을 걸러 낸다. 지우는 시점을 따로 두면 그 사이에 멎은 값이
    실시간인 척 나간다.
    """

    def __init__(self, mode: Mode = "live", gate: float = 0.4) -> None:
        self.mode = mode
        self.gate = gate
        self._feeds: dict[str, Feed] = {}

    # --- 쓰기 ---

    def feed(self, key: str) -> Feed:
        found = self._feeds.get(key)
        if found is None:
            # source 는 화면의 카드가 "어디서 온 값인가"로 쓴다. 세션 토큰을 그대로
            # 쓰면 비밀이 화면까지 나간다.
            found = Feed(source="browser", mode=self.mode, gate=self.gate)
            self._feeds[key] = found
            log.info("feeds.opened", sessions=len(self._feeds))
        return found

    def drop(self, key: str) -> None:
        if self._feeds.pop(key, None) is not None:
            log.info("feeds.closed", sessions=len(self._feeds))

    def prune(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        for key in [k for k, f in self._feeds.items() if now - f.touched > STALE_AFTER_S]:
            self.drop(key)

    # --- Mapping ---

    def __getitem__(self, key: str) -> list[Metric]:
        found = self._feeds.get(key)
        if found is None or time.monotonic() - found.touched > STALE_AFTER_S:
            raise KeyError(key)
        return found.metrics()

    def __iter__(self) -> Iterator[str]:
        return iter(self._feeds)

    def __len__(self) -> int:
        return len(self._feeds)
