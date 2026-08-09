"""L4 — 보호자 알림.

reversible=False 다. base.py 계약대로 **지표 근거와 사용자 확인을 모두** 거친다
(README §4). 여기서 사용자 확인은 취소 창이다.

    이상 지속 → 화면에 경고 + 카운트다운 → 취소 없으면 발송
                                        → 취소하면 사유만 기록

카운트다운을 두는 이유: 메일은 되돌릴 수 없다. 새벽에 오작동으로 보호자를 깨우면
그 시스템은 다음 날 꺼진다. 한 번 꺼진 시스템은 진짜 필요할 때도 꺼져 있다.

발화 조건은 프로파일이 정한다 (README §0-5).

    abnormal_hr       재실 중인데 심박수가 정상 대역 밖으로 sustain_s 지속
    measurement_lost  재실 중인데 심박수를 lost_sustain_s 동안 못 잡음

demo 는 둘 다 켜서 개발 중에 두 경로를 다 볼 수 있게 하고, production 은
abnormal_hr 만 켠다. measurement_lost 는 센서를 가리거나 자세를 바꾸기만 해도
뜨는 조건이라 실사용에서는 보호자를 자주 부르게 된다.

이 정책은 "이상"을 의학적으로 판단하지 않는다. thresholds.yaml 에 적힌 대역을
벗어난 상태가 얼마나 이어졌는지만 본다 (README §1 비목표).
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping

import structlog

from actuators.base import Actuator, Notifier
from api.schemas import InterventionEvent, Snapshot
from core.policy.base import InterventionPolicy, find, value_of
from core.thresholds import Thresholds

log = structlog.get_logger(__name__)

ABNORMAL_HR = "abnormal_hr"
MEASUREMENT_LOST = "measurement_lost"


class L4Guardian(InterventionPolicy):
    level = "L4"
    reversible = False  # 보낸 메일은 못 되돌린다

    def __init__(
        self,
        thresholds: Thresholds,
        actuators: Mapping[str, Actuator],
        *,
        notifier_id: str = "guardian_email",
        metric_key: str = "hr",
    ) -> None:
        super().__init__(thresholds, actuators)
        params = thresholds.policy("l4_guardian")
        self.triggers: set[str] = set(params.get("triggers", [ABNORMAL_HR]))
        self.lost_sustain_s = float(params.get("lost_sustain_s", 180))
        self.cooldown_s = int(params.get("cooldown_s", 1800))
        # 평가 창이 곧 취소 창이다. 이 시간이 지나야 evaluate 가 불리고 거기서 보낸다.
        self.evaluate_after_s = int(params.get("cancel_window_s", 30))
        self.hr = thresholds.hr
        self.metric_key = metric_key

        notifier = actuators.get(notifier_id)
        self.notifier: Notifier | None = notifier if isinstance(notifier, Notifier) else None
        if notifier is not None and self.notifier is None:
            log.warning("l4.actuator_not_a_notifier", actuator=notifier_id)

        # 조건이 언제부터 이어졌는지. 단조시계를 쓴다 — 벽시계는 튈 수 있다.
        self._abnormal_since: float | None = None
        self._lost_since: float | None = None

    def should_fire(self, snapshot: Snapshot) -> bool:
        now = time.monotonic()
        occupancy = value_of(snapshot, "occupancy")

        if occupancy is None:
            self._reset()
            return self._hold("재실 지표가 없다")
        if occupancy < 0.5:
            # 아무도 없는 방의 심박수는 이상한 게 정상이다.
            self._reset()
            return self._hold("방에 사람이 없다")

        reason = self._sustained(snapshot, now)
        if reason is None:
            return self._hold("이상이 지속되지 않았다")

        # 여기부터 주 조건이 맞은 상태. 막히면 near_miss 로 남긴다 (README §8).
        if self.notifier is None:
            return self._hold("알림 액추에이터가 연결돼 있지 않다", near_miss=True)
        return self._go(reason)

    def _sustained(self, snapshot: Snapshot, now: float) -> str | None:
        """지속된 이상이 있으면 사유 문자열, 없으면 None."""
        hr = value_of(snapshot, self.metric_key)

        if ABNORMAL_HR in self.triggers and hr is not None:
            if hr < self.hr.low or hr > self.hr.high:
                self._abnormal_since = self._abnormal_since or now
                held = now - self._abnormal_since
                if held >= self.hr.sustain_s:
                    return (
                        f"심박수 {hr:.0f}bpm 이 정상 대역 "
                        f"{self.hr.low:.0f}~{self.hr.high:.0f} 밖으로 {held:.0f}초 지속"
                    )
            else:
                self._abnormal_since = None
        elif ABNORMAL_HR in self.triggers:
            # 값을 못 구한 동안은 대역 판단을 할 수 없다. 타이머를 늘리지 않는다.
            self._abnormal_since = None

        if MEASUREMENT_LOST in self.triggers:
            measured = find(snapshot, self.metric_key)
            if measured is not None and hr is None:
                self._lost_since = self._lost_since or now
                held = now - self._lost_since
                if held >= self.lost_sustain_s:
                    return f"사람은 있는데 심박수를 {held:.0f}초 동안 측정하지 못함"
            else:
                self._lost_since = None

        return None

    def _reset(self) -> None:
        self._abnormal_since = None
        self._lost_since = None

    async def fire(self, snapshot: Snapshot) -> InterventionEvent:
        """아직 보내지 않는다. 카운트다운을 시작할 뿐이다.

        accepted=None 이 "사용자 확인 대기 중"이라는 뜻이고 (README §2 계약),
        화면은 이걸 보고 취소 버튼을 띄운다.
        """
        return InterventionEvent(
            id=uuid.uuid4().hex[:12],
            level=self.level,
            action="notify_guardian",
            trigger=self.last_reason,
            before=self._state(snapshot),
            after=None,
            accepted=None,
            ts=snapshot.ts,
        )

    async def evaluate(
        self, event: InterventionEvent, snapshot: Snapshot
    ) -> InterventionEvent:
        """취소 창이 끝났다. 여기서 실제로 보낸다."""
        after = self._state(snapshot)

        if event.accepted is False:
            log.info("l4.cancelled", id=event.id, trigger=event.trigger)
            return event.model_copy(update={"after": after or None})

        if self.notifier is None:
            # 창이 도는 사이 액추에이터가 죽었다. 안 보낸 걸 보냈다고 하지 않는다.
            log.warning("l4.notifier_gone", id=event.id)
            return event.model_copy(update={"after": after or None, "accepted": False})

        await self.notifier.notify(
            subject=f"[{snapshot.device_id}] 확인이 필요합니다",
            body=(
                f"{event.trigger}\n\n"
                f"기기: {snapshot.device_id}\n"
                f"시각: {event.ts.astimezone().isoformat(timespec='seconds')}\n\n"
                "이 메일은 자동 발송되었습니다. 의료 진단이 아니며 참고용입니다."
            ),
        )
        return event.model_copy(update={"after": after or None, "accepted": True})

    def _state(self, snapshot: Snapshot) -> dict[str, float]:
        state: dict[str, float] = {}
        hr = value_of(snapshot, self.metric_key)
        occupancy = value_of(snapshot, "occupancy")
        if hr is not None:
            state[self.metric_key] = round(hr, 1)
        if occupancy is not None:
            state["occupancy"] = round(occupancy, 1)
        return state
