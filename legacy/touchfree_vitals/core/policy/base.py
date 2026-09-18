"""개입 정책 계약.

되돌릴 수 있는 개입(reversible=True)만 자동 실행한다. reversible=False
(보호자 호출, 응급 에스컬레이션)는 지표 근거 + 사용자 확인을 모두 거쳐야 한다
(README §4).

should_fire 는 계약대로 bool 을 돌려준다. 다만 "왜 안 했는지"도 남겨야 하므로
(README §8) 판단 근거를 last_reason 에 기록한다. 반환형을 바꾸지 않으려고
상태로 뺐다.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping

from actuators.base import Actuator
from api.schemas import InterventionEvent, Level, Metric, Snapshot
from core.thresholds import Thresholds


class InterventionPolicy(ABC):
    level: Level
    reversible: bool
    cooldown_s: int
    # 개입 후 효과를 재는 시각까지의 대기. README §5 의 "N초 후 재측정".
    evaluate_after_s: int = 20

    def __init__(self, thresholds: Thresholds, actuators: Mapping[str, Actuator]) -> None:
        """registry 가 이 형태로 생성한다. 하위 클래스는 추가 인자를 keyword 로 받는다."""
        self.thresholds = thresholds
        # 마지막 판단 근거. 실행기가 로그에 남긴다.
        self.last_reason = ""
        # 주 조건은 맞았는데 다른 게 막은 경우. 민감도 조정 때 이 기록이 필요하다.
        self.near_miss = False

    @abstractmethod
    def should_fire(self, snapshot: Snapshot) -> bool: ...

    @abstractmethod
    async def fire(self, snapshot: Snapshot) -> InterventionEvent: ...

    @abstractmethod
    async def evaluate(
        self, event: InterventionEvent, snapshot: Snapshot
    ) -> InterventionEvent:
        """개입 후 평가 윈도우가 끝나면 after 를 채워 돌려준다."""

    def _hold(self, reason: str, *, near_miss: bool = False) -> bool:
        self.last_reason = reason
        self.near_miss = near_miss
        return False

    def _go(self, reason: str) -> bool:
        self.last_reason = reason
        self.near_miss = False
        return True


def find(snapshot: Snapshot, key: str) -> Metric | None:
    return next((m for m in snapshot.metrics if m.key == key), None)


def value_of(snapshot: Snapshot, key: str) -> float | None:
    """믿을 수 있는 수치만 돌려준다.

    보류된 값(None)은 물론이고 state 가 ok 가 아닌 값도 판단에 쓰지 않는다.
    품질 미달인 지표로 개입을 결정하면 그 개입이 근거를 잃는다.
    """
    metric = find(snapshot, key)
    if metric is None or metric.state != "ok" or not isinstance(metric.value, int | float):
        return None
    return float(metric.value)


def confidence_of(snapshot: Snapshot, key: str) -> float | None:
    """지표의 신뢰도. 값이 보류돼 있어도 신뢰도는 판단에 쓸 수 있다."""
    metric = find(snapshot, key)
    return None if metric is None else metric.confidence
