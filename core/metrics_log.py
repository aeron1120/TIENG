"""지표 CSV 로깅.

스냅샷의 ts 를 그대로 쓴다. 나중에 개입 로그와 join 하려면 두 로그가 같은 시간
축 위에 있어야 한다 (README §8).

보류된 값(value 비어 있음)도 그대로 남긴다. 검증 슬라이드의 "보류율"은 이 행들을
세어서 나온다.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, TextIO

from api.schemas import Snapshot

COLUMNS = ["ts", "device_id", "key", "value", "unit", "source", "mode", "state", "confidence"]


class MetricCsvLogger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._fh: TextIO | None = None
        self._writer: Any = None  # csv.writer 는 타입으로 쓸 수 없다

    def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        is_new = not self.path.exists() or self.path.stat().st_size == 0
        self._fh = self.path.open("a", newline="", encoding="utf-8")
        self._writer = csv.writer(self._fh)
        if is_new:
            self._writer.writerow(COLUMNS)
            self._fh.flush()

    def write(self, snapshot: Snapshot) -> None:
        if self._writer is None or self._fh is None:
            return
        ts = snapshot.ts.isoformat()
        self._writer.writerows(
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
        # 데모 중에 tail 로 들여다볼 수 있어야 한다.
        self._fh.flush()

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
            self._writer = None
