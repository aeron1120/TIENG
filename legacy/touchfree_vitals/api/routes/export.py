"""기록 조회와 CSV 내보내기.

메모리에 들고 있는 최근 개입은 20건뿐이라(runner) 그 이상을 보려면 CSV 를 읽어야
한다. 발표 자료를 만들 때 원본 CSV 를 그대로 받아 갈 수 있게 다운로드도 연다.

logs/ 밖의 파일은 열지 않는다.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter()

ROOT = Path(__file__).resolve().parents[2]
LOGS = ROOT / "logs"


@router.get("/api/logs")
async def list_logs() -> list[dict[str, Any]]:
    if not LOGS.is_dir():
        return []
    return [
        {
            "name": p.name,
            "size_kb": round(p.stat().st_size / 1024, 1),
            "rows": max(0, sum(1 for _ in p.open(encoding="utf-8", errors="replace")) - 1),
        }
        for p in sorted(LOGS.glob("*.csv"))
    ]


def _safe(name: str) -> Path:
    path = (LOGS / name).resolve()
    # 상위로 빠져나가는 경로를 막는다.
    if not path.is_file() or LOGS.resolve() not in path.parents:
        raise HTTPException(404, f"logs/{name} 을 찾을 수 없다")
    return path


@router.get("/api/logs/{name}/download")
async def download(name: str) -> FileResponse:
    return FileResponse(_safe(name), media_type="text/csv", filename=name)


@router.get("/api/logs/interventions")
async def intervention_history(
    name: str = "interventions.csv", limit: int = 200
) -> list[dict[str, Any]]:
    """개입 이력. 최신이 앞에 온다.

    before/after 는 CSV 에 JSON 문자열로 들어 있어 여기서 풀어 준다. 화면이
    문자열을 다시 파싱하게 두면 형식이 두 군데로 갈라진다.
    """
    path = LOGS / name
    if not path.is_file():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))

    out = []
    for row in reversed(rows[-limit:]):
        for field in ("before", "after"):
            raw = row.get(field) or ""
            try:
                row[field] = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                row[field] = None
        out.append(row)
    return out
