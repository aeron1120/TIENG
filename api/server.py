"""FastAPI 경계 (CLAUDE.md §3).

여기가 모듈과 화면이 만나는 **유일한 지점**이다. core/ 는 화면을 모르고, web/ 은
core/ 를 모른다. 둘 사이에 있는 것은 Snapshot 하나뿐이다 (§2).

경로에 /api 접두사를 붙인 이유: 빌드된 화면을 같은 포트로 내보내면 catch-all 이
필요한데, 접두사가 없으면 그 catch-all 이 API 까지 삼킨다. 개발 중에는 vite 가
/api 와 /ws 만 여기로 넘긴다 (web/vite.config.ts).

§11 은 파이프라인과 대시보드를 다른 터미널에서 띄우라고 적어 두었지만, 그러면 두
프로세스가 메모리를 공유하지 않아 스냅샷이 건너오지 않는다. 그래서 여기서는 lifespan
이 파이프라인을 같이 띄운다. `python -m core.pipeline` 은 화면 없이 기록만 하는
경로로 그대로 남는다.
"""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import structlog
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from api.ws import Hub
from api.ws import router as ws_router
from core import config as config_mod
from core.pipeline import Pipeline
from core.schemas import Event, Snapshot

log = structlog.get_logger(__name__)

PUSH_HZ = 10.0  # 화면 갱신율. 융합 루프(50Hz)를 그대로 밀 이유가 없다.


async def _push_loop(app: FastAPI) -> None:
    pipeline: Pipeline = app.state.pipeline
    hub: Hub = app.state.hub
    period = 1.0 / PUSH_HZ
    next_at = asyncio.get_running_loop().time()
    while True:
        try:
            if pipeline.latest is not None:
                await hub.broadcast(pipeline.latest)
        except Exception as exc:  # noqa: BLE001
            # 루프가 죽으면 화면이 통째로 멎는다. 한 틱을 버리고 계속 돈다.
            log.error("push_loop.tick_failed", error=str(exc))
        next_at += period
        await asyncio.sleep(max(0.0, next_at - asyncio.get_running_loop().time()))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    cfg = config_mod.load(Path(os.environ.get("MOTO_CONFIG") or config_mod.DEFAULT_PATH))
    source = os.environ.get("MOTO_SOURCE", "sim")

    pipeline = Pipeline(cfg, source)
    # 파이프라인은 스레드로 돈다. 1kHz 어댑터를 asyncio 로 끌고 오면 이벤트 루프가
    # 샘플 하나마다 깨어나고, 그 지터가 그대로 타임스탬프에 섞인다 (§5).
    worker = threading.Thread(target=pipeline.run, name="pipeline", daemon=True)

    app.state.config = cfg
    app.state.pipeline = pipeline
    app.state.hub = Hub()
    worker.start()
    log.info("startup", session=pipeline.session_id, mode=pipeline.mode)

    task = asyncio.create_task(_push_loop(app))
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        pipeline.stop()
        worker.join(timeout=5.0)


app = FastAPI(title="Moto crash sensing", lifespan=lifespan)
app.include_router(ws_router)


@app.get("/api/snapshot")
async def snapshot() -> Snapshot:
    latest: Snapshot | None = app.state.pipeline.latest
    if latest is None:
        # 첫 틱 전이다. 빈 스냅샷을 지어내면 화면이 0 을 진짜 값으로 그린다 (§0-4).
        raise HTTPException(503, "아직 첫 틱이 돌지 않았다")
    return latest


@app.get("/api/events")
async def events() -> list[Event]:
    """§13-9 전까지는 항상 비어 있다. 규칙이 없으니 이벤트도 없다."""
    latest: Snapshot | None = app.state.pipeline.latest
    return latest.recent_events if latest is not None else []


WEB_DIST = Path(__file__).resolve().parents[1] / "web" / "dist"


def _serve_web(dist: Path) -> None:
    """빌드된 화면을 API 와 같은 포트로 내보낸다.

    파이에 올릴 때 vite dev 서버를 띄우지 않기 위해서다. 포트가 하나면 프록시도
    CORS 도 systemd 유닛을 둘로 나눌 일도 없다. 라우터를 전부 등록한 뒤에 붙인다.
    """
    index = dist / "index.html"
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        # /api 나 /ws 인데 여기까지 왔다는 건 없는 경로라는 뜻이다. index.html 을
        # 돌려주면 JSON 을 기다리던 쪽이 HTML 을 받아 엉뚱한 데서 깨진다.
        if path.startswith(("api/", "ws")):
            raise HTTPException(404, f"/{path} 는 없는 경로다")
        target = (root / path).resolve()
        if path and target.is_file() and target.is_relative_to(root):
            return FileResponse(target)
        return FileResponse(index)


if WEB_DIST.is_dir():
    _serve_web(WEB_DIST)
else:
    # 개발 PC 는 vite dev 서버가 화면을 맡는다. 여기서 catch-all 을 걸어 두면 없는
    # API 경로가 404 대신 빈 화면으로 보여 헷갈린다.
    log.info("web.dist_missing", path=str(WEB_DIST))
