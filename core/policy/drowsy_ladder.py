"""졸음 단계별 순차 알림.

졸음은 갑자기 오지 않는다. 그래서 알림도 한 번에 최대로 가지 않는다.

    관심(warning) 지속 → L2 화면 경고
    위험(drowsy) 지속  → L3 화면 경고 + 조명 상향
    위험이 더 지속     → L4 보호자 알림 (취소 창)

판정을 만드는 것은 여기가 아니라 어댑터다 (core/adapters/drowsiness.py). 여기서는
그 판정이 **얼마나 이어졌는지**만 보고 단계를 올린다. 점수 임계는 사람마다 달라
튜닝 프로파일에 있고, 지속 시간은 정책이라 thresholds.yaml 에 있다.

단계마다 정책 인스턴스를 하나씩 둔다. 한 클래스가 사다리를 통째로 들고 level 을
바꿔 가며 발화하게 하면 두 가지가 깨진다.

    /api/system 이 내보내는 (level, reversible) 표가 흔들린다. 화면의 취소 창은
    그 표에서 되돌릴 수 없는 정책을 찾아 뜬다 (web/src/components/PendingAlert.tsx).

    reversible 이 단계마다 다르다. 화면과 조명은 되돌릴 수 있고 메일은 아니다.
    클래스 하나에 값이 하나뿐이면 이 구분을 표현할 곳이 없다.

순서는 상태로 강제하지 않는다. 지속 시간이 단계마다 다르면 (5초 < 20초 < 60초)
순서는 시간이 알아서 만든다. 단계끼리 서로를 모르므로 하나를 꺼도 나머지가 돈다.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass

import structlog

from actuators.base import Actuator, Notifier, Switch
from api.schemas import InterventionEvent, Level, Snapshot
from core.policy.base import InterventionPolicy, find, value_of
from core.thresholds import Thresholds

log = structlog.get_logger(__name__)

# 어댑터가 내보내는 판정. 낮은 것부터.
RANK = {"awake": 0, "warning": 1, "drowsy": 2}

ALERT = "drowsy_alert"
GUARDIAN = "notify_guardian"


@dataclass(frozen=True)
class Rung:
    level: Level
    action: str
    reversible: bool
    min_verdict: str  # 이 판정 이상일 때만 센다
    sustain_s: float  # 그 상태가 이만큼 이어지면 발화
    cooldown_s: int
    evaluate_after_s: int


# 기본값이다. 실제 값은 thresholds.yaml 의 프로파일이 덮는다 (README §0-5).
RUNGS: dict[str, Rung] = {
    "notice": Rung("L2", "drowsy_notice", True, "warning", 5, 60, 20),
    "alert": Rung("L3", ALERT, True, "drowsy", 20, 120, 20),
    # 메일은 되돌릴 수 없다. 그래서 취소 창(evaluate_after_s)을 길게 둔다.
    "guardian": Rung("L4", GUARDIAN, False, "drowsy", 60, 600, 30),
}

# 개입 전후로 남길 지표. 나중에 왜 이 단계가 떴는지를 이 값들로 되짚는다.
EVIDENCE = ("drowsy_score", "drowsy_trend", "perclos", "blink_rate")


class DrowsyLadder(InterventionPolicy):
    """사다리의 한 칸. rung 이 어느 칸인지 정한다."""

    def __init__(
        self,
        thresholds: Thresholds,
        actuators: Mapping[str, Actuator],
        *,
        rung: str = "notice",
        switch_id: str = "room_light",
        notifier_id: str = "guardian_email",
        metric_key: str = "drowsiness",
    ) -> None:
        super().__init__(thresholds, actuators)
        if rung not in RUNGS:
            raise ValueError(f"모르는 단계다: {rung!r} (가능: {', '.join(RUNGS)})")
        spec = RUNGS[rung]
        params = thresholds.policy("drowsy_ladder").get(rung, {})

        self.rung = rung
        # 클래스 속성을 인스턴스로 덮는다. 같은 클래스인데 칸마다 달라야 한다.
        self.level = spec.level
        self.reversible = spec.reversible
        self.action = spec.action
        self.min_verdict = spec.min_verdict
        self.sustain_s = float(params.get("sustain_s", spec.sustain_s))
        self.cooldown_s = int(params.get("cooldown_s", spec.cooldown_s))
        self.evaluate_after_s = int(
            params.get("cancel_window_s", params.get("evaluate_after_s", spec.evaluate_after_s))
        )
        self.metric_key = metric_key

        # 조명은 L3 만, 메일은 L4 만 쓴다. 안 쓰는 칸은 들고 있지 않는다 — 쓰지도
        # 않을 액추에이터가 없다는 이유로 보류하는 일이 생기면 안 된다.
        switch = actuators.get(switch_id) if self.action == ALERT else None
        self.switch: Switch | None = switch if isinstance(switch, Switch) else None
        if switch is not None and self.switch is None:
            log.warning("drowsy.actuator_not_a_switch", actuator=switch_id)

        notifier = actuators.get(notifier_id) if self.action == GUARDIAN else None
        self.notifier: Notifier | None = notifier if isinstance(notifier, Notifier) else None
        if notifier is not None and self.notifier is None:
            log.warning("drowsy.actuator_not_a_notifier", actuator=notifier_id)

        # 조건이 언제부터 이어졌는지. 벽시계는 튈 수 있어 단조시계를 쓴다.
        self._since: float | None = None

    # --- 판단 --------------------------------------------------------------- #

    def should_fire(self, snapshot: Snapshot) -> bool:
        verdict = self._verdict(snapshot)
        if verdict is None:
            self._since = None
            return self._hold("졸음 판정이 없다")

        if RANK[verdict] < RANK[self.min_verdict]:
            self._since = None
            return self._hold(f"판정이 {verdict} 라 {self.min_verdict} 에 못 미친다")

        now = time.monotonic()
        self._since = self._since or now
        held = now - self._since
        if held < self.sustain_s:
            return self._hold(
                f"{verdict} 가 {held:.0f}초 — {self.sustain_s:.0f}초는 이어져야 한다"
            )

        # 여기부터 주 조건이 맞은 상태. 막히면 near_miss 로 남긴다 (README §8).
        if self.action == ALERT:
            if self.switch is None:
                return self._hold("조명 액추에이터가 연결돼 있지 않다", near_miss=True)
            if self.switch.is_on:
                return self._hold("조명이 이미 켜져 있다", near_miss=True)
        if self.action == GUARDIAN and self.notifier is None:
            return self._hold("알림 액추에이터가 연결돼 있지 않다", near_miss=True)

        return self._go(f"졸음 판정 {verdict} 가 {held:.0f}초 지속")

    def _verdict(self, snapshot: Snapshot) -> str | None:
        """어댑터의 판정 문자열. 못 믿을 상태면 None.

        value_of 를 쓸 수 없다. 이 지표만 값이 수치가 아니라 문자열이다.
        """
        metric = find(snapshot, self.metric_key)
        if metric is None or metric.state != "ok":
            return None
        return metric.value if metric.value in RANK else None

    # --- 발화 --------------------------------------------------------------- #

    async def fire(self, snapshot: Snapshot) -> InterventionEvent:
        # 쿨다운 동안에는 runner 가 should_fire 를 부르지 않아 타이머가 갱신되지
        # 않는다. 리셋하지 않으면 쿨다운이 풀리는 순간 낡은 시작 시각으로 곧바로
        # 다시 발화한다 (l4_guardian 에 같은 이유가 적혀 있다).
        self._since = None

        if self.action == ALERT:
            if self.switch is None:
                raise RuntimeError("조명 액추에이터가 없다")
            await self.switch.turn_on()

        return InterventionEvent(
            id=uuid.uuid4().hex[:12],
            level=self.level,
            action=self.action,
            trigger=self.last_reason,
            before=self._evidence(snapshot),
            after=None,
            # L4 만 사람의 확인을 기다린다. 나머지는 자동 개입이라 확인 대상이 아니다.
            accepted=None,
            ts=snapshot.ts,
        )

    async def evaluate(
        self, event: InterventionEvent, snapshot: Snapshot
    ) -> InterventionEvent:
        after = self._evidence(snapshot)

        if self.action != GUARDIAN:
            # 값을 못 구했으면 빈 dict 가 아니라 None 이다. 쟀는데 0 인 것과 못 잰
            # 것은 다르다 (README §0-4).
            return event.model_copy(update={"after": after or None})

        # 여기부터 L4. 취소 창이 끝났고 이제 실제로 보낸다.
        if event.accepted is False:
            log.info("drowsy.cancelled", id=event.id, trigger=event.trigger)
            return event.model_copy(update={"after": after or None})

        if self.notifier is None:
            # 창이 도는 사이 액추에이터가 죽었다. 안 보낸 걸 보냈다고 하지 않는다.
            log.warning("drowsy.notifier_gone", id=event.id)
            return event.model_copy(update={"after": after or None, "accepted": False})

        await self.notifier.notify(
            subject=f"[{snapshot.device_id}] 졸음이 계속되고 있습니다",
            body=(
                f"{event.trigger}\n\n"
                f"기기: {snapshot.device_id}\n"
                f"시각: {event.ts.astimezone().isoformat(timespec='seconds')}\n\n"
                "이 메일은 자동 발송되었습니다. 의료 진단이 아니며 참고용입니다."
            ),
        )
        return event.model_copy(update={"after": after or None, "accepted": True})

    def _evidence(self, snapshot: Snapshot) -> dict[str, float]:
        state: dict[str, float] = {}
        for key in EVIDENCE:
            got = value_of(snapshot, key)
            if got is not None:
                state[key] = round(got, 2)
        return state
