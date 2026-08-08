"""FastAPI 진입점. 샘플링 루프 하나가 스냅샷을 만들고 모든 구독자에게 민다."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import structlog
from fastapi import FastAPI

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
app.include_router(snapshot_router)
app.include_router(interventions_router)
app.include_router(system_router)
app.include_router(export_router)
app.include_router(diagnostics_router)
app.include_router(camera_router)
app.include_router(layout_router)
app.include_router(ws_router)
