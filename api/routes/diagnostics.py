"""자체 검증과 정량 검증을 화면에서 돌린다.

둘 다 **별도 프로세스로 돌린다.** 서버 안에서 직접 부르면 mock 들이 공유하는
방 상태(core.sim_room)를 건드려 라이브 대시보드가 흔들리고, 정책 실행기가
중간에 이상한 값을 보게 된다. 검증이 관측 대상을 바꾸면 안 된다.

정량 검증은 파일 경로를 클라이언트에서 받는다. 임의 경로를 그대로 열면 서버의
아무 파일이나 읽히므로, 서버가 스스로 찾은 데이터셋 목록 안에 있는 것만 받는다.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
# 검증 데이터가 있을 수 있는 곳. 여기 밖의 파일은 열지 않는다.
DATA_DIRS = [ROOT / "logs", ROOT / "legacy" / "tieng_rppg" / "validation"]
TIMEOUT_S = 120


async def _run(args: list[str]) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        sys.executable, *args,
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout=TIMEOUT_S)
    except TimeoutError:
        process.kill()
        raise HTTPException(504, f"{TIMEOUT_S}초 안에 안 끝났다") from None
    return process.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


# --- 자체 검증 ---------------------------------------------------------------- #


@router.post("/api/selftest")
async def run_selftest() -> dict[str, Any]:
    code, out, err = await _run([str(SCRIPTS / "selftest.py"), "--json"])
    try:
        result: dict[str, Any] = json.loads(out)
    except json.JSONDecodeError:
        # 실패해도 화면에는 뭐라도 보여야 원인을 찾는다.
        raise HTTPException(500, f"자체 검증 출력을 읽지 못했다\n{err or out}") from None
    result["exit_code"] = code
    return result


# --- 정량 검증 ---------------------------------------------------------------- #


def _datasets() -> list[dict[str, str]]:
    """추정 CSV 와 기준 CSV 를 이름으로 짝지어 고른다.

    legacy 세션은 static_demo_r1.csv / static1_ref.csv 처럼 접두어가 다르다.
    완벽히 맞추려 들기보다 후보를 다 보여주고 사람이 고르게 한다.
    """
    found: list[dict[str, str]] = []
    for folder in DATA_DIRS:
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.csv")):
            kind = "reference" if "_ref" in path.stem or "oximeter" in path.stem else "estimate"
            found.append({
                "path": str(path.relative_to(ROOT).as_posix()),
                "name": path.name,
                "kind": kind,
                "size_kb": f"{path.stat().st_size / 1024:.1f}",
            })
    return found


@router.get("/api/validation/datasets")
async def datasets() -> list[dict[str, str]]:
    return _datasets()


class ValidationRequest(BaseModel):
    rppg: str
    ref: str
    gate: float = 0.5
    ref_warmup_sec: float = 20.0
    demo_warmup_sec: float = 0.0
    tolerance: float = 2.0


@router.post("/api/validation")
async def run_validation(req: ValidationRequest) -> dict[str, Any]:
    allowed = {d["path"] for d in _datasets()}
    for label, value in (("rppg", req.rppg), ("ref", req.ref)):
        if value not in allowed:
            raise HTTPException(400, f"{label} 경로가 허용 목록에 없다: {value}")

    code, out, err = await _run([
        str(SCRIPTS / "validate_vs_oximeter.py"),
        "--rppg", req.rppg,
        "--ref", req.ref,
        "--gate", str(req.gate),
        "--ref-warmup-sec", str(req.ref_warmup_sec),
        "--demo-warmup-sec", str(req.demo_warmup_sec),
        "--tolerance", str(req.tolerance),
    ])
    if code != 0:
        raise HTTPException(400, err.strip() or out.strip() or "검증 실패")
    return {"markdown": out, "exit_code": code}
