"""FastAPI 진입점. 샘플링 루프 하나가 스냅샷을 만들고 모든 구독자에게 민다."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import structlog
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse

from api import auth
from api.auth import Users, require
from api.routes.auth import admin as auth_admin_router
from api.routes.auth import router as auth_router
from api.routes.camera import router as camera_router
from api.routes.diagnostics import router as diagnostics_router
from api.routes.export import router as export_router
from api.routes.interventions import router as interventions_router
from api.routes.layout import router as layout_router
from api.routes.snapshot import router as snapshot_router
from api.routes.system import router as system_router
from api.schemas import Snapshot, server_now
from api.ws import Hub
from api.ws import router as ws_router
from core.csv_logs import InterventionCsvLogger, MetricCsvLogger
from core.policy.runner import PolicyRunner
from core.registry import Registry

log = structlog.get_logger(__name__)

DEFAULT_CONFIG = Path("config/device.yaml")


def _config_path() -> Path:
    return Path(os.environ.get("DEVICE_CONFIG") or DEFAULT_CONFIG)


def _users_path() -> Path:
    # 기기 설정(config)이 아니라 사용 흔적이라 state/ 에 둔다 — layout.json 과 같은 자리.
    return Path(os.environ.get("TFV_USERS_DB") or auth.DEFAULT_PATH)


async def _sample_loop(app: FastAPI) -> None:
    registry: Registry = app.state.registry
    hub: Hub = app.state.hub
    runner: PolicyRunner = app.state.runner
    csv_log: MetricCsvLogger | None = app.state.metrics_csv
    period = 1.0 / registry.config.sample_rate_hz

    # sleep(period)만 쓰면 처리 시간만큼 주기가 밀린다. 절대 시각 기준으로 맞춘다.
    next_at = time.monotonic()
    while True:
        try:
            ts = server_now()
            snapshot = Snapshot(
                device_id=registry.config.device_id,
                ts=ts,
                metrics=await registry.read_all(ts),
                interventions=[],
            )
            # 정책은 방금 만든 지표를 보고 판단한다. 발화한 개입은 같은 스냅샷에
            # 실어 보내야 화면에서 "왜 켜졌는지"가 값과 같이 보인다.
            await runner.tick(snapshot)
            snapshot = snapshot.model_copy(update={"interventions": runner.recent})

            app.state.latest = snapshot
            if csv_log is not None:
                csv_log.write_snapshot(snapshot)
            await hub.broadcast(snapshot)
        except Exception as exc:
            # 루프가 죽으면 대시보드가 통째로 멎는다. 한 틱을 버리고 계속 돈다.
            log.error("sample_loop.tick_failed", error=str(exc))

        next_at += period
        await asyncio.sleep(max(0.0, next_at - time.monotonic()))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    path = _config_path()
    log.info("startup", config=str(path))

    registry = Registry.from_yaml(path)
    await registry.start()

    users = Users(_users_path())
    users.init()
    app.state.users = users

    metrics_csv = _open_log(MetricCsvLogger, registry.config.metrics_csv, "metrics_csv")
    interventions_csv = _open_log(
        InterventionCsvLogger, registry.config.interventions_csv, "interventions_csv"
    )

    app.state.registry = registry
    app.state.config_path = path
    app.state.runner = PolicyRunner(registry.policies, sink=interventions_csv)
    app.state.hub = Hub()
    app.state.latest = None
    app.state.metrics_csv = metrics_csv

    task = asyncio.create_task(_sample_loop(app))
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await app.state.runner.stop()
        await registry.stop()
        for logger in (metrics_csv, interventions_csv):
            if logger is not None:
                logger.close()


def _open_log(cls: type, path: str | None, name: str):  # type: ignore[no-untyped-def]
    if not path:
        return None
    logger = cls(Path(path))
    logger.open()
    log.info(f"{name}.open", path=path)
    return logger


app = FastAPI(title="TouchFree Vitals", lifespan=lifespan)

# 어떤 화면이 어디까지 보는지를 한군데서 읽히게 한다. 엔드포인트마다 데코레이터를
# 달면 권한이 여덟 파일에 흩어져서, 라우터를 하나 추가할 때 빠뜨려도 티가 안 난다.
#
# guest  비회원. 지금 이 방의 상태만 본다.
# member 승인된 계정. 기록·설정·검증까지.
guest = [Depends(require("guest"))]
member = [Depends(require("member"))]

app.include_router(auth_router)
app.include_router(auth_admin_router)
app.include_router(snapshot_router, dependencies=guest)
app.include_router(camera_router, dependencies=guest)
app.include_router(layout_router, dependencies=guest)
app.include_router(interventions_router, dependencies=member)
app.include_router(system_router, dependencies=member)
app.include_router(export_router, dependencies=member)
app.include_router(diagnostics_router, dependencies=member)
app.include_router(ws_router)  # 세션 확인은 api/ws.py 안에서 한다

# 빌드된 화면은 코드 옆에 있다. 서버를 어디서 띄우든 같은 곳을 봐야 하므로
# cwd 가 아니라 이 파일 기준으로 잡는다 (config 경로와 달리 기기 설정이 아니다).
WEB_DIST = Path(__file__).resolve().parents[1] / "web" / "dist"


def _serve_web(dist: Path) -> None:
    """빌드된 화면을 API 와 같은 포트로 내보낸다.

    파이에 올릴 때 vite dev 서버를 띄우지 않기 위해서다. 포트가 하나면 프록시
    설정도, CORS 도, systemd 유닛을 둘로 나눌 일도 없다.

    라우팅은 react-router 가 브라우저에서 한다. 그래서 /records 같은 경로를 주소창에
    직접 치면 서버에는 그런 파일이 없다 — 실제 파일이면 그 파일을, 아니면
    index.html 을 돌려주고 나머지는 화면이 알아서 판단하게 한다.

    라우터를 전부 등록한 뒤에 붙인다. 먼저 붙이면 이 catch-all 이 /api 까지
    삼킨다.
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
        # 요청 경로로 dist 밖을 가리킬 수 있으면 안 된다.
        if path and target.is_file() and target.is_relative_to(root):
            return FileResponse(target)
        return FileResponse(index)


# 빌드가 없으면 붙이지 않는다. 개발 PC 는 vite dev 서버가 화면을 맡고, 여기서
# catch-all 을 걸어 두면 없는 API 경로가 404 대신 빈 화면으로 보여 헷갈린다.
if WEB_DIST.is_dir():
    _serve_web(WEB_DIST)
else:
    log.info("web.dist_missing", path=str(WEB_DIST))
