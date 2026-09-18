"""지표·개입 CSV 로깅.

두 로그가 같은 ts 축 위에 있어야 나중에 join 할 수 있다. 개입 전후로 지표가
어떻게 움직였는지가 이 프로젝트의 핵심 근거다 (README §8).

보류된 값도, 발화하지 않은 개입도 남긴다. 나중에 민감도를 조정하려면 "안 한
이유"가 필요하고, 검증 슬라이드의 보류율은 빈 칸을 세어서 나온다.
"""

from __future__ import annotations

import csv
import json
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any, TextIO

from api.schemas import InterventionEvent, Snapshot

METRIC_COLUMNS = [
    "ts", "device_id", "key", "value", "unit", "source", "mode", "state", "confidence",
]
INTERVENTION_COLUMNS = [
    "ts", "kind", "id", "level", "action", "trigger", "before", "after", "accepted",
]


class _Appender:
    """헤더를 한 번만 쓰고 이어붙이는 CSV. 데모 중 tail 로 볼 수 있게 매번 flush."""

    def __init__(self, path: Path, columns: list[str]) -> None:
        self.path = Path(path)
        self.columns = columns
        self._fh: TextIO | None = None
        self._writer: Any = None

    def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fresh = not self.path.exists() or self.path.stat().st_size == 0
        self._fh = self.path.open("a", newline="", encoding="utf-8")
        self._writer = csv.writer(self._fh)
        if fresh:
            self._writer.writerow(self.columns)
            self._fh.flush()

    def write(self, rows: Iterable[list[Any]]) -> None:
        if self._writer is None or self._fh is None:
            return
        self._writer.writerows(rows)
        self._fh.flush()

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
            self._writer = None


class MetricCsvLogger(_Appender):
    def __init__(self, path: Path) -> None:
        super().__init__(path, METRIC_COLUMNS)

    def write_snapshot(self, snapshot: Snapshot) -> None:
        ts = snapshot.ts.isoformat()
        self.write(
            [
                ts,
                snapshot.device_id,
                m.key,
                "" if m.value is None else m.value,
                m.unit or "",
                m.source,
                m.mode,
                m.state,
                "" if m.confidence is None else f"{m.confidence:.3f}",
            ]
            for m in snapshot.metrics
        )


class InterventionCsvLogger(_Appender):
    def __init__(self, path: Path) -> None:
        super().__init__(path, INTERVENTION_COLUMNS)

    def write_event(self, event: InterventionEvent) -> None:
        # after 가 채워졌다는 건 평가까지 끝났다는 뜻이다.
        kind = "evaluated" if event.after is not None else "fired"
        self.write(
            [
                [
                    event.ts.isoformat(),
                    kind,
                    event.id,
                    event.level,
                    event.action,
                    event.trigger,
                    _dumps(event.before),
                    _dumps(event.after),
                    "" if event.accepted is None else str(event.accepted).lower(),
                ]
            ]
        )

    def write_blocked(self, level: str, reason: str, ts: datetime) -> None:
        """주 조건은 맞았는데 발화하지 않은 순간. 민감도 조정의 근거가 된다."""
        self.write([[ts.isoformat(), "blocked", "", level, "", reason, "", "", ""]])


def _dumps(value: dict[str, float] | None) -> str:
    return "" if value is None else json.dumps(value, ensure_ascii=False, sort_keys=True)
