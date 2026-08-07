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

from api.routes.snapshot import router as snapshot_router
from api.schemas import Snapshot, server_now
from api.ws import Hub
from api.ws import router as ws_router
from core.metrics_log import MetricCsvLogger
from core.registry import Registry

log = structlog.get_logger(__name__)

DEFAULT_CONFIG = Path("config/device.yaml")


def _config_path() -> Path:
    return Path(os.environ.get("DEVICE_CONFIG") or DEFAULT_CONFIG)


async def _sample_loop(app: FastAPI) -> None:
    registry: Registry = app.state.registry
    hub: Hub = app.state.hub
    csv_log: MetricCsvLogger | None = app.state.csv_log
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
                interventions=[],  # 정책은 Phase 3·5
            )
            app.state.latest = snapshot
            if csv_log is not None:
                csv_log.write(snapshot)
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

    csv_log: MetricCsvLogger | None = None
    if registry.config.metrics_csv:
        csv_log = MetricCsvLogger(Path(registry.config.metrics_csv))
        csv_log.open()
        log.info("metrics_csv.open", path=registry.config.metrics_csv)

    app.state.registry = registry
    app.state.hub = Hub()
    app.state.latest = None
    app.state.csv_log = csv_log

    task = asyncio.create_task(_sample_loop(app))
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await registry.stop()
        if csv_log is not None:
            csv_log.close()


app = FastAPI(title="TouchFree Vitals", lifespan=lifespan)
app.include_router(snapshot_router)
app.include_router(ws_router)
