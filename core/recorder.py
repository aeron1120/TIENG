"""세션 기록 (CLAUDE.md §8).

meta.json 에 config 를 통째로 넣는 이유: 나중에 임계값을 바꿨을 때 **어떤 설정으로
찍힌 데이터인지** 모르면 데이터 전체가 쓸모없어진다.

parquet 스키마를 pyarrow 의 추론에 맡기지 않고 모델에서 직접 만든다. 추론에 맡기면
첫 배치의 temp 가 전부 None 일 때 그 열이 null 타입으로 굳어서, 나중에 온도가 실린
배치가 들어오는 순간 기록이 통째로 실패한다.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import UnionType
from typing import Any, Literal, Union, get_args, get_origin

import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

_SCALARS: dict[Any, pa.DataType] = {
    float: pa.float64(),
    int: pa.int64(),
    str: pa.string(),
    bool: pa.bool_(),
}


def _arrow_type(annotation: Any) -> pa.DataType:
    """파이썬 타입 주석 하나를 parquet 타입으로. 없는 값은 전부 nullable 이다."""
    origin = get_origin(annotation)
    if origin is Literal:
        return pa.string()  # Literal["ok", ...] 은 문자열 열이다
    if origin in (Union, UnionType):
        # `float | None` 에서 None 을 뺀 나머지가 실제 타입이다.
        rest = [a for a in get_args(annotation) if a is not type(None)]
        if len(rest) != 1:
            raise TypeError(f"parquet 로 내보낼 수 없는 합타입이다: {annotation}")
        return _arrow_type(rest[0])
    if annotation in _SCALARS:
        return _SCALARS[annotation]
    raise TypeError(f"parquet 로 내보낼 수 없는 타입이다: {annotation}")


def schema_of(model: type[BaseModel]) -> pa.Schema:
    return pa.schema(
        [pa.field(name, _arrow_type(f.annotation)) for name, f in model.model_fields.items()]
    )


def git_commit() -> str | None:
    """어떤 코드로 찍힌 데이터인지 (§8). 저장소 밖에서 돌면 None 이다."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


class SessionRecorder:
    """스트림별 parquet + events.jsonl (§8).

    배치마다 써 내린다. 메모리에 모았다가 종료 시 한 번에 쓰면, 주행 중 전원이
    끊겼을 때 그 세션이 통째로 사라진다.
    """

    def __init__(self, root: Path, name: str) -> None:
        self.dir = Path(root) / name
        self._writers: dict[str, pq.ParquetWriter] = {}
        self._events: Any = None

    def open(self, meta: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        self._events = (self.dir / "events.jsonl").open("w", encoding="utf-8")

    def add(self, stream: str, rows: list[Any]) -> None:
        if not rows:
            return
        writer = self._writers.get(stream)
        if writer is None:
            writer = pq.ParquetWriter(self.dir / f"{stream}.parquet", schema_of(type(rows[0])))
            self._writers[stream] = writer
        writer.write_table(
            pa.Table.from_pylist([r.model_dump() for r in rows], schema=writer.schema)
        )

    def add_event(self, event: BaseModel) -> None:
        if self._events is not None:
            self._events.write(event.model_dump_json() + "\n")

    def close(self) -> None:
        for writer in self._writers.values():
            writer.close()
        self._writers.clear()
        if self._events is not None:
            self._events.close()
            self._events = None


def read_stream(session_dir: Path, stream: str, model: type[BaseModel]) -> list[Any]:
    """기록한 것을 그대로 되읽는다 (§13-2 검증)."""
    path = Path(session_dir) / f"{stream}.parquet"
    if not path.exists():
        return []
    return [model.model_validate(row) for row in pq.read_table(path).to_pylist()]
