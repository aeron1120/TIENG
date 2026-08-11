"""config 에 적힌 어댑터·액추에이터·정책을 동적으로 로드한다.

셋 다 같은 규칙이다. 파일 하나를 추가하고 config 에 한 줄 적으면 기능이 붙는다.
어느 하나가 죽어도 파이프라인 전체는 계속 돌아야 하므로 (README §0-3) 로드·시작·
읽기 실패를 전부 여기서 흡수하고, 지표는 state 를 강등한 Metric 으로 바꿔 내보낸다.
"""

from __future__ import annotations

import asyncio
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
from core.adapters.base import PreviewSource, SensorAdapter
from core.overrides import Overrides
from core.policy.base import InterventionPolicy
from core.thresholds import Thresholds
from core.thresholds import load as load_thresholds

log = structlog.get_logger(__name__)

T = TypeVar("T")

# backend 를 고를 수 있는 어댑터. 모듈로 찾는 이유는 id 가 config 마다 다르기
# 때문이다 (device.mock.yaml 에는 아예 없다).
CAMERA_MODULE = "core.adapters.rppg"
# 이 어댑터의 기본값과 같아야 한다. registry 가 rppg 를 import 하면 개발 PC 에서도
# cv2 가 딸려 오므로 (importlib 로 늦게 여는 이유가 그것이다) 값만 옮겨 적는다.
DEFAULT_CAMERA_BACKEND = "opencv"


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
        # 왜 못 올라왔는지. 화면에서 바로 읽을 수 있어야 배선을 고칠 수 있다.
        self._failures: dict[str, str] = {}
        # 카드 하나를 다시 여는 동안 또 열라는 요청이 오면 카메라를 두 번 잡는다.
        # 두 번째가 "device busy" 로 실패해서, 고친 사람 눈에는 방금 고른 값이
        # 안 먹은 것처럼 보인다.
        self._restart_lock = asyncio.Lock()

    @classmethod
    def from_yaml(cls, path: Path, overrides: Overrides | None = None) -> Registry:
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        registry = cls(DeviceConfig.model_validate(raw))
        if overrides is not None and overrides.camera_backend is not None:
            registry.set_camera_backend(overrides.camera_backend)
        return registry

    # --- 수명주기 ----------------------------------------------------------- #

    async def start(self) -> None:
        await self._start_adapters()
        await self._start_actuators()
        self._build_policies()

    async def restart_adapter(self, adapter_id: str) -> None:
        """어댑터 하나만 다시 연다.

        샘플 루프는 계속 돈다. read_all 이 매 틱 _adapters 를 새로 들여다보므로,
        비어 있는 동안에는 그 카드만 no_adapter 로 나가고 나머지 지표는 그대로다.

        실패해도 예외를 올리지 않는다. 카메라가 안 열리는 것은 여기서 흔한 결과이고
        (그걸 확인하려고 바꿔 보는 것이다), 사유는 _failures 를 거쳐 화면에 그대로
        실린다 — start() 때와 같은 자리다.
        """
        entry = next((e for e in self.config.adapters if e.id == adapter_id), None)
        if entry is None:
            raise LookupError(f"{adapter_id} 는 config 에 없는 어댑터다")

        async with self._restart_lock:
            old = self._adapters.pop(adapter_id, None)
            if old is not None:
                try:
                    await old.stop()
                except Exception as exc:
                    # 못 닫아도 새로 여는 것은 시도한다. 여기서 멈추면 카드가
                    # 영영 안 돌아온다.
                    log.warning("adapter.stop_failed", adapter=adapter_id, error=str(exc))
            self._failures.pop(adapter_id, None)
            await self._start_one(entry)

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

    # --- 상태 --------------------------------------------------------------- #

    def status(self) -> dict[str, Any]:
        """무엇이 올라왔고 무엇이 왜 안 올라왔는지.

        하드웨어를 붙일 때 서버 로그를 뒤지는 대신 화면에서 바로 보라고 만든다.
        실패 사유를 그대로 실어 보낸다 — 요약하면 배선을 고칠 단서가 사라진다.
        """
        adapters: list[dict[str, Any]] = []
        for adapter_entry in self.config.adapters:
            if adapter_entry.id in self._adapters:
                state = "running"
            elif adapter_entry.mode == "unavailable":
                state = "disabled"
            else:
                state = "failed"
            adapters.append({
                "id": adapter_entry.id,
                "module": adapter_entry.module,
                "mode": adapter_entry.mode,
                "provides": self._provides.get(
                    adapter_entry.id, list(adapter_entry.provides)
                ),
                "state": state,
                "detail": self._failures.get(adapter_entry.id, ""),
            })

        actuators: list[dict[str, Any]] = []
        for entry in self.config.actuators:
            live = self.actuators.get(entry.id)
            actuators.append({
                "id": entry.id,
                "module": entry.module,
                "mode": entry.mode,
                "state": "running" if live is not None else "failed",
                "detail": self._failures.get(entry.id, ""),
                "is_on": bool(getattr(live, "is_on", False)) if live is not None else False,
            })

        policies = [
            {
                "level": p.level,
                "module": type(p).__module__,
                "reversible": p.reversible,
                "cooldown_s": p.cooldown_s,
                "evaluate_after_s": p.evaluate_after_s,
                "last_reason": p.last_reason,
                "near_miss": p.near_miss,
            }
            for p in self.policies
        ]

        thresholds = None
        if self.thresholds is not None:
            thresholds = {
                "profile": self.thresholds.profile,
                "confidence_min": self.thresholds.confidence_min,
                "night_mode": self.thresholds.night_mode.model_dump(),
                "policies": self.thresholds.policies,
            }

        return {
            "device_id": self.config.device_id,
            "sample_rate_hz": self.config.sample_rate_hz,
            "thresholds_path": self.config.thresholds,
            "thresholds": thresholds,
            # 카메라 어댑터가 없는 구성(mock)에서는 None 이다.
            "camera_backend": self.camera_backend(),
            "camera_adapter": getattr(self.camera_entry(), "id", None),
            "adapters": adapters,
            "actuators": actuators,
            "policies": policies,
        }

    # --- 카메라 백엔드 ------------------------------------------------------- #
    # CSI 리본이 안 열릴 때 화면에서 opencv 로 바꿔 볼 수 있어야 한다. 파이에 ssh 로
    # 붙어 device.yaml 을 고치고 서비스를 재시작하는 것이 원래 절차인데, 카메라가
    # 왜 안 잡히는지 찾는 중에 그 왕복은 비싸다.

    def camera_entry(self) -> AdapterEntry | None:
        """backend 를 고를 수 있는 어댑터. 없으면 화면이 선택칸을 감춘다."""
        return next((e for e in self.config.adapters if e.module == CAMERA_MODULE), None)

    def camera_backend(self) -> str | None:
        entry = self.camera_entry()
        if entry is None:
            return None
        return str(entry.params.get("backend", DEFAULT_CAMERA_BACKEND))

    def set_camera_backend(self, backend: str) -> None:
        """다음에 여는 것부터 적용된다. 지금 돌고 있는 것은 restart_adapter 가 갈아 끼운다."""
        entry = self.camera_entry()
        if entry is None:
            raise LookupError(f"{CAMERA_MODULE} 어댑터가 config 에 없다")
        entry.params["backend"] = backend

    def preview_sources(self) -> dict[str, PreviewSource]:
        """카메라 화면을 내보낼 수 있는 어댑터.

        비어 있는 게 정상인 경우가 많다 (mock 구성, 카메라 미연결). 미리보기가
        없을 뿐이고 파이프라인은 그대로 돈다.
        """
        return {
            adapter_id: adapter
            for adapter_id, adapter in self._adapters.items()
            if isinstance(adapter, PreviewSource)
        }

    # --- 로딩 --------------------------------------------------------------- #

    async def _start_adapters(self) -> None:
        for entry in self.config.adapters:
            await self._start_one(entry)

    async def _start_one(self, entry: AdapterEntry) -> None:
        adapter, provides = self._build_adapter(entry)
        self._provides[entry.id] = provides
        if adapter is None:
            return
        try:
            await adapter.start()
        except Exception as exc:
            # 하드웨어가 아직 안 붙은 흔한 경우다. 카드는 no_adapter 로 뜬다.
            log.warning("adapter.start_failed", adapter=entry.id, error=str(exc))
            self._failures[entry.id] = str(exc)
            return
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
            self._failures[entry.id] = str(exc)
            return None, list(entry.provides)

        if entry.mode == "unavailable":
            log.info("adapter.disabled", adapter=entry.id)
            return None, list(cls.provides)

        try:
            adapter = cls(id=entry.id, mode=entry.mode, **entry.params)
        except Exception as exc:
            log.warning("adapter.init_failed", adapter=entry.id, error=str(exc))
            self._failures[entry.id] = str(exc)
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
                self._failures[entry.id] = str(exc)
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
