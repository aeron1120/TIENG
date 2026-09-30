"""세션 시계 (CLAUDE.md §2).

모든 t 는 세션 시작을 0 으로 하는 단조 시계 기준 초다. 벽시계는 세션 메타데이터에
한 번만 기록한다 — 어댑터가 각자 시계를 쓰기 시작하면 융합이 무의미해진다.

time.time() 이 아니라 time.monotonic() 인 이유: NTP 보정이나 서머타임이 주행 중에
들어오면 벽시계는 뒤로 갈 수 있다. 그러면 샘플 순서가 뒤집혀 리플레이가 깨진다 (§9).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass(frozen=True)
class SessionClock:
    """세션 하나의 시간 원점."""

    started_wall: datetime = field(default_factory=lambda: datetime.now(UTC))
    origin: float = field(default_factory=time.monotonic)

    def now(self) -> float:
        """세션 시작 이후 경과 초."""
        return time.monotonic() - self.origin

    def dir_name(self, device_id: str) -> str:
        """sessions/<id> 디렉터리 이름 (§8)."""
        return f"{self.started_wall.strftime('%Y-%m-%dT%H-%M-%S')}_{device_id}"
