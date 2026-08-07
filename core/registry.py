"""config에 적힌 어댑터를 동적으로 로드하고, 한 틱 분량의 Metric을 모은다.

어댑터 하나가 죽어도 파이프라인 전체는 계속 돌아야 하므로 (README §0-3)
로드·시작·읽기 실패를 전부 여기서 흡수하고 state를 강등한 Metric으로 바꿔 내보낸다.
"""

from __future__ import annotations

import importlib
from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import structlog
import yaml
from pydantic import BaseModel, Field

from api.schemas import Metric, Mode, State
from core.adapters.base import SensorAdapter

log = structlog.get_logger(__name__)


class AdapterEntry(BaseModel):
    id: str
    module: str
    mode: Mode = "live"
    # 모듈이 아직 없거나 import가 깨진 어댑터의 카드 자리를 예약한다.
    # 모듈이 정상 로드되면 어댑터 클래스의 provides가 이 값을 대체한다.
    provides: list[str] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)


class DeviceConfig(BaseModel):
    device_id: str
    sample_rate_hz: float = 1.0
    metrics_csv: str | None = None  # 비우면 CSV 로깅을 하지 않는다
    adapters: list[AdapterEntry] = Field(default_factory=list)


class Registry:
    def __init__(self, config: DeviceConfig) -> None:
        self.config = config
        self._adapters: dict[str, SensorAdapter] = {}
        self._provides: dict[str, list[str]] = {}

    @classmethod
    def from_yaml(cls, path: Path) -> Registry:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        return cls(DeviceConfig.model_validate(raw))

    async def start(self) -> None:
        for entry in self.config.adapters:
            adapter, provides = self._build(entry)
            self._provides[entry.id] = provides
            if adapter is None:
                continue
            try:
                await adapter.start()
            except Exception as exc:
                log.warning("adapter.start_failed", adapter=entry.id, error=str(exc))
                continue
            self._adapters[entry.id] = adapter
            log.info("adapter.started", adapter=entry.id, mode=entry.mode, provides=provides)

    async def stop(self) -> None:
        for adapter in self._adapters.values():
            try:
                await adapter.stop()
            except Exception as exc:
                log.warning("adapter.stop_failed", adapter=adapter.id, error=str(exc))
        self._adapters.clear()

    async def read_all(self, ts: datetime) -> list[Metric]:
        """한 틱 분량의 지표. ts는 호출자가 넘긴 서버 시계로 통일한다 (README §2)."""
        out: list[Metric] = []
        for entry in self.config.adapters:  # 카드 순서 = config 순서
            adapter = self._adapters.get(entry.id)
            if adapter is None:
                out += _blanks(entry.id, self._provides[entry.id], "unavailable", "no_adapter", ts)
                continue
            try:
                metrics = await adapter.read()
            except Exception as exc:
                log.warning("adapter.read_failed", adapter=entry.id, error=str(exc))
                out += _blanks(entry.id, self._provides[entry.id], adapter.mode, "error", ts)
                continue
            out += [m.model_copy(update={"ts": ts}) for m in metrics]
        return out

    def _build(self, entry: AdapterEntry) -> tuple[SensorAdapter | None, list[str]]:
        """(어댑터, provides). 어댑터가 None이면 값 없는 카드만 띄운다."""
        try:
            module = importlib.import_module(entry.module)
            cls = _adapter_class(module)
        except Exception as exc:
            log.warning(
                "adapter.load_failed", adapter=entry.id, module=entry.module, error=str(exc)
            )
            return None, list(entry.provides)

        if entry.mode == "unavailable":
            log.info("adapter.disabled", adapter=entry.id)
            return None, list(cls.provides)

        try:
            adapter = cls(id=entry.id, mode=entry.mode, **entry.params)
        except Exception as exc:
            log.warning("adapter.init_failed", adapter=entry.id, error=str(exc))
            return None, list(cls.provides)
        return adapter, list(adapter.provides)


def _blanks(
    source: str, provides: list[str], mode: Mode, state: State, ts: datetime
) -> list[Metric]:
    """값을 못 구한 어댑터의 자리. 값을 지어내지 않고 None으로 남긴다 (README §0-4)."""
    return [
        Metric(
            key=key,
            value=None,
            unit=None,
            source=source,
            mode=mode,
            state=state,
            confidence=None,
            ts=ts,
        )
        for key in provides
    ]


def _adapter_class(module: ModuleType) -> type[SensorAdapter]:
    found = [
        obj
        for obj in vars(module).values()
        if isinstance(obj, type)
        and issubclass(obj, SensorAdapter)
        and obj.__module__ == module.__name__
    ]
    if len(found) != 1:
        raise LookupError(
            f"{module.__name__}: SensorAdapter 구현이 정확히 1개여야 한다 (발견 {len(found)}개)"
        )
    return found[0]
