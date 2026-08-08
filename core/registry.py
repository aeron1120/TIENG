"""config 에 적힌 어댑터·액추에이터·정책을 동적으로 로드한다.

셋 다 같은 규칙이다. 파일 하나를 추가하고 config 에 한 줄 적으면 기능이 붙는다.
어느 하나가 죽어도 파이프라인 전체는 계속 돌아야 하므로 (README §0-3) 로드·시작·
읽기 실패를 전부 여기서 흡수하고, 지표는 state 를 강등한 Metric 으로 바꿔 내보낸다.
"""

from __future__ import annotations

import importlib
from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import Any, TypeVar

import structlog
import yaml
from pydantic import BaseModel, Field

from actuators.base import Actuator
from api.schemas import Metric, Mode, State
from core.adapters.base import SensorAdapter
from core.policy.base import InterventionPolicy
from core.thresholds import Thresholds
from core.thresholds import load as load_thresholds

log = structlog.get_logger(__name__)

T = TypeVar("T")


class AdapterEntry(BaseModel):
    id: str
    module: str
    mode: Mode = "live"
    # 모듈이 아직 없거나 import 가 깨진 어댑터의 카드 자리를 예약한다.
    # 모듈이 정상 로드되면 어댑터 클래스의 provides 가 이 값을 대체한다.
    provides: list[str] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)


class ActuatorEntry(BaseModel):
    id: str
    module: str
    mode: Mode = "live"
    params: dict[str, Any] = Field(default_factory=dict)


class PolicyEntry(BaseModel):
    module: str
    enabled: bool = True
    params: dict[str, Any] = Field(default_factory=dict)


class DeviceConfig(BaseModel):
    device_id: str
    sample_rate_hz: float = 1.0
    thresholds: str = "config/thresholds.yaml"
    metrics_csv: str | None = None  # 비우면 CSV 로깅을 하지 않는다
    interventions_csv: str | None = None
    adapters: list[AdapterEntry] = Field(default_factory=list)
    actuators: list[ActuatorEntry] = Field(default_factory=list)
    policies: list[PolicyEntry] = Field(default_factory=list)


class Registry:
    def __init__(self, config: DeviceConfig) -> None:
        self.config = config
        self.actuators: dict[str, Actuator] = {}
        self.policies: list[InterventionPolicy] = []
        self.thresholds: Thresholds | None = None
        self._adapters: dict[str, SensorAdapter] = {}
        self._provides: dict[str, list[str]] = {}

    @classmethod
    def from_yaml(cls, path: Path) -> Registry:
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls(DeviceConfig.model_validate(raw))

    # --- 수명주기 ----------------------------------------------------------- #

    async def start(self) -> None:
        await self._start_adapters()
        await self._start_actuators()
        self._build_policies()

    async def stop(self) -> None:
        for adapter in self._adapters.values():
            try:
                await adapter.stop()
            except Exception as exc:
                log.warning("adapter.stop_failed", adapter=adapter.id, error=str(exc))
        self._adapters.clear()

        for actuator in self.actuators.values():
            try:
                await actuator.stop()
            except Exception as exc:
                log.warning("actuator.stop_failed", actuator=actuator.id, error=str(exc))
        self.actuators.clear()
        self.policies.clear()

    # --- 지표 --------------------------------------------------------------- #

    async def read_all(self, ts: datetime) -> list[Metric]:
        """한 틱 분량의 지표. ts 는 호출자가 넘긴 서버 시계로 통일한다 (README §2)."""
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

    # --- 로딩 --------------------------------------------------------------- #

    async def _start_adapters(self) -> None:
        for entry in self.config.adapters:
            adapter, provides = self._build_adapter(entry)
            self._provides[entry.id] = provides
            if adapter is None:
                continue
            try:
                await adapter.start()
            except Exception as exc:
                # 하드웨어가 아직 안 붙은 흔한 경우다. 카드는 no_adapter 로 뜬다.
                log.warning("adapter.start_failed", adapter=entry.id, error=str(exc))
                continue
            self._adapters[entry.id] = adapter
            log.info("adapter.started", adapter=entry.id, mode=entry.mode, provides=provides)

    def _build_adapter(self, entry: AdapterEntry) -> tuple[SensorAdapter | None, list[str]]:
        """(어댑터, provides). 어댑터가 None 이면 값 없는 카드만 띄운다."""
        try:
            module = importlib.import_module(entry.module)
            # 추상 베이스를 '이 모양을 구현했나' 필터로 넘긴다. 인스턴스화는 하지 않는다.
            cls = _implementation(module, SensorAdapter)  # type: ignore[type-abstract]
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

    async def _start_actuators(self) -> None:
        for entry in self.config.actuators:
            try:
                cls = _implementation(importlib.import_module(entry.module), Actuator)  # type: ignore[type-abstract]
                actuator = cls(id=entry.id, mode=entry.mode, **entry.params)
                await actuator.start()
            except Exception as exc:
                log.warning(
                    "actuator.unavailable", actuator=entry.id, module=entry.module, error=str(exc)
                )
                continue
            self.actuators[entry.id] = actuator
            log.info("actuator.started", actuator=entry.id, mode=entry.mode)

    def _build_policies(self) -> None:
        enabled = [e for e in self.config.policies if e.enabled]
        if not enabled:
            return
        try:
            self.thresholds = load_thresholds(Path(self.config.thresholds))
        except Exception as exc:
            # 임계값을 못 읽으면 개입을 아예 하지 않는다. 기본값을 지어내서
            # 남의 집 불을 켜는 것보다 아무것도 안 하는 쪽이 안전하다.
            log.error("thresholds.load_failed", path=self.config.thresholds, error=str(exc))
            return
        log.info("thresholds.loaded", profile=self.thresholds.profile)

        for entry in enabled:
            try:
                cls = _implementation(importlib.import_module(entry.module), InterventionPolicy)  # type: ignore[type-abstract]
                policy = cls(self.thresholds, self.actuators, **entry.params)
            except Exception as exc:
                log.warning("policy.load_failed", module=entry.module, error=str(exc))
                continue
            self.policies.append(policy)
            log.info(
                "policy.loaded", level=policy.level, module=entry.module,
                cooldown_s=policy.cooldown_s, reversible=policy.reversible,
            )


def _blanks(
    source: str, provides: list[str], mode: Mode, state: State, ts: datetime
) -> list[Metric]:
    """값을 못 구한 어댑터의 자리. 값을 지어내지 않고 None 으로 남긴다 (README §0-4)."""
    return [
        Metric(
            key=key, value=None, unit=None, source=source,
            mode=mode, state=state, confidence=None, ts=ts,
        )
        for key in provides
    ]


def _implementation(module: ModuleType, base: type[T]) -> type[T]:
    """모듈 안에서 base 를 구현한 클래스 하나를 찾는다.

    등록 보일러플레이트 없이 파일만 떨어뜨리면 되도록 이렇게 한다. 대신 한 모듈에
    구현이 둘 이상이면 어느 쪽인지 알 수 없으므로 그때는 실패시킨다.
    """
    found = [
        obj
        for obj in vars(module).values()
        if isinstance(obj, type) and issubclass(obj, base) and obj.__module__ == module.__name__
    ]
    if len(found) != 1:
        raise LookupError(
            f"{module.__name__}: {base.__name__} 구현이 정확히 1개여야 한다 (발견 {len(found)}개)"
        )
    return found[0]
