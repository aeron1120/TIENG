"""L1 — 조도 기반 조명 개입.

이 프로젝트의 시그니처 기능이다. rPPG SDK 들은 "밝은 곳에서 측정하세요"를
사용자에게 시키지만, 여기서는 그 문장을 시스템이 대신 실행한다 (README §5).

야간 예외는 반드시 지킨다. 22~07시에는 신뢰도가 떨어져도 불을 켜지 않는다.
자는 사람을 깨우는 개입은 그 자체로 해롭다. 대신 사유를 남겨 나중에 민감도를
조정할 수 있게 한다.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping

import structlog

from actuators.base import Actuator, Switch
from api.schemas import InterventionEvent, Snapshot
from core.policy.base import InterventionPolicy, confidence_of, value_of
from core.thresholds import Thresholds

log = structlog.get_logger(__name__)


class L1Light(InterventionPolicy):
    level = "L1"
    reversible = True  # 불은 다시 끄면 원상복구된다

    def __init__(
        self,
        thresholds: Thresholds,
        actuators: Mapping[str, Actuator],
        *,
        switch_id: str = "room_light",
        metric_key: str = "hr",
    ) -> None:
        super().__init__(thresholds, actuators)
        params = thresholds.policy("l1_light")
        self.confidence_min = float(params.get("confidence_min", thresholds.confidence_min))
        self.lux_min = float(params.get("lux_min", 80.0))
        self.cooldown_s = int(params.get("cooldown_s", 300))
        self.evaluate_after_s = int(params.get("evaluate_after_s", 20))
        self.night_mode = thresholds.night_mode
        self.metric_key = metric_key

        switch = actuators.get(switch_id)
        self.switch: Switch | None = switch if isinstance(switch, Switch) else None
        if switch is not None and self.switch is None:
            log.warning("l1.actuator_not_a_switch", actuator=switch_id)

    def should_fire(self, snapshot: Snapshot) -> bool:
        confidence = confidence_of(snapshot, self.metric_key)
        lux = value_of(snapshot, "lux")

        if confidence is None:
            return self._hold(f"{self.metric_key} 신뢰도를 아직 모른다")
        if lux is None:
            return self._hold("조도 지표가 없다")

        if confidence >= self.confidence_min:
            return self._hold(f"신뢰도 {confidence:.2f} 는 기준 이상")
        if lux >= self.lux_min:
            # 어둡지 않은데 신뢰도가 낮다면 원인이 조명이 아니다. 불을 켜도 안 낫는다.
            return self._hold(f"조도 {lux:.0f}lx 는 충분하다 (원인이 조명이 아님)")

        # 여기부터는 주 조건이 맞은 상태. 막히면 near_miss 로 남긴다.
        if self.night_mode.covers(snapshot.ts):
            return self._hold("야간 모드 — 자는 사람을 깨우지 않는다", near_miss=True)
        if self.switch is None:
            return self._hold("조명 액추에이터가 연결돼 있지 않다", near_miss=True)
        if self.switch.is_on:
            return self._hold("조명이 이미 켜져 있다", near_miss=True)

        return self._go(
            f"신뢰도 {confidence:.2f} < {self.confidence_min} 이고 "
            f"조도 {lux:.0f}lx < {self.lux_min:.0f}lx"
        )

    async def fire(self, snapshot: Snapshot) -> InterventionEvent:
        if self.switch is None:
            raise RuntimeError("조명 액추에이터가 없다")
        await self.switch.turn_on()

        before = {}
        confidence = confidence_of(snapshot, self.metric_key)
        lux = value_of(snapshot, "lux")
        if confidence is not None:
            before[f"{self.metric_key}_confidence"] = round(confidence, 3)
        if lux is not None:
            before["lux"] = round(lux, 1)

        return InterventionEvent(
            id=uuid.uuid4().hex[:12],
            level=self.level,
            action="light_up",
            trigger=self.last_reason,
            before=before,
            after=None,
            # 자동 개입이라 사용자가 수락/거절할 대상이 아니다.
            accepted=None,
            ts=snapshot.ts,
        )

    async def evaluate(
        self, event: InterventionEvent, snapshot: Snapshot
    ) -> InterventionEvent:
        after: dict[str, float] = {}
        confidence = confidence_of(snapshot, self.metric_key)
        lux = value_of(snapshot, "lux")
        if confidence is not None:
            after[f"{self.metric_key}_confidence"] = round(confidence, 3)
        if lux is not None:
            after["lux"] = round(lux, 1)

        # 값을 못 구했으면 빈 dict 가 아니라 None 으로 둔다. "측정했는데 0"과
        # "측정 못 함"은 다르다 (README §0-4).
        return event.model_copy(update={"after": after or None})
