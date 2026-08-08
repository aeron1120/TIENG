"""정책 실행기.

매 틱마다 (1) 평가 시각이 된 개입의 after 를 채우고 (2) 발화할 정책을 고른다.

쿨다운과 평가 대기는 정책마다 따로 두지 않고 여기서 공통으로 관리한다. 정책은
"지금 발화할 조건인가"만 판단하면 된다.

정책 하나가 터져도 나머지는 계속 돈다. 어댑터와 같은 규칙이다 (README §0-3).
"""

from __future__ import annotations

import time
from collections import deque
from datetime import datetime
from typing import Protocol

import structlog

from api.schemas import InterventionEvent, Snapshot
from core.policy.base import InterventionPolicy

log = structlog.get_logger(__name__)

RECENT_MAX = 20  # 스냅샷에 실어 보낼 최근 개입 수


class EventSink(Protocol):
    def write_event(self, event: InterventionEvent) -> None: ...

    def write_blocked(self, level: str, reason: str, ts: datetime) -> None: ...


class PolicyRunner:
    def __init__(self, policies: list[InterventionPolicy], sink: EventSink | None = None) -> None:
        self.policies = policies
        self._sink = sink
        self._last_fire: dict[str, float] = {}
        self._pending: list[tuple[InterventionPolicy, InterventionEvent, float]] = []
        self._recent: deque[InterventionEvent] = deque(maxlen=RECENT_MAX)
        # 같은 사유를 1초마다 다시 적지 않기 위한 직전 상태
        self._last_note: dict[str, str] = {}

    @property
    def recent(self) -> list[InterventionEvent]:
        """최신이 앞에 오도록. 화면은 방금 일어난 일을 먼저 본다."""
        return list(reversed(self._recent))

    async def tick(self, snapshot: Snapshot) -> None:
        now = time.monotonic()
        await self._settle(snapshot, now)
        await self._maybe_fire(snapshot, now)

    async def stop(self) -> None:
        """평가를 못 마친 개입은 그대로 둔다. after 가 비어 있는 것도 기록이다."""
        self._pending.clear()

    # --- 평가 --------------------------------------------------------------- #

    async def _settle(self, snapshot: Snapshot, now: float) -> None:
        waiting: list[tuple[InterventionPolicy, InterventionEvent, float]] = []
        for policy, event, due in self._pending:
            if now < due:
                waiting.append((policy, event, due))
                continue
            try:
                settled = await policy.evaluate(event, snapshot)
            except Exception as exc:
                log.warning("policy.evaluate_failed", level=policy.level, error=str(exc))
                continue
            self._replace(settled)
            if self._sink is not None:
                self._sink.write_event(settled)
            log.info(
                "policy.evaluated", level=policy.level, id=settled.id,
                before=settled.before, after=settled.after,
            )
        self._pending = waiting

    def _replace(self, event: InterventionEvent) -> None:
        for i, existing in enumerate(self._recent):
            if existing.id == event.id:
                self._recent[i] = event
                return
        self._recent.append(event)

    # --- 발화 --------------------------------------------------------------- #

    async def _maybe_fire(self, snapshot: Snapshot, now: float) -> None:
        for policy in self.policies:
            last = self._last_fire.get(policy.level)
            if last is not None and now - last < policy.cooldown_s:
                self._note(policy.level, f"쿨다운 {policy.cooldown_s}초 대기 중", snapshot.ts,
                           record=False)
                continue

            try:
                ready = policy.should_fire(snapshot)
            except Exception as exc:
                log.warning("policy.should_fire_failed", level=policy.level, error=str(exc))
                continue

            if not ready:
                # 주 조건이 맞았는데 막힌 경우만 CSV 에 남긴다. 매 틱 남기면
                # "조건 안 맞음" 행이 파일을 덮어 정작 필요한 기록이 묻힌다.
                self._note(policy.level, policy.last_reason, snapshot.ts,
                           record=policy.near_miss)
                continue

            try:
                event = await policy.fire(snapshot)
            except Exception as exc:
                log.warning("policy.fire_failed", level=policy.level, error=str(exc))
                continue

            self._last_fire[policy.level] = now
            self._recent.append(event)
            self._pending.append((policy, event, now + policy.evaluate_after_s))
            self._last_note.pop(policy.level, None)
            if self._sink is not None:
                self._sink.write_event(event)
            log.info(
                "policy.fired", level=policy.level, id=event.id,
                action=event.action, trigger=event.trigger,
            )

    def _note(self, level: str, reason: str, ts: datetime, *, record: bool) -> None:
        if self._last_note.get(level) == reason:
            return
        self._last_note[level] = reason
        log.debug("policy.held", level=level, reason=reason)
        if record and self._sink is not None:
            self._sink.write_blocked(level, reason, ts)
