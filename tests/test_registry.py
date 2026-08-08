"""registry가 README §0-3 (어댑터가 죽어도 파이프라인은 돈다) 를 지키는지."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from api.schemas import Metric, server_now
from core.adapters.rr_mock import RespirationMock
from core.registry import AdapterEntry, DeviceConfig, Registry

TS = datetime(2026, 1, 1, tzinfo=UTC)
REPO_ROOT = Path(__file__).resolve().parents[1]


def _registry(*entries: AdapterEntry) -> Registry:
    return Registry(DeviceConfig(device_id="test", adapters=list(entries)))


async def test_dead_adapter_degrades_to_error_and_others_keep_running() -> None:
    reg = _registry(
        AdapterEntry(id="boom", module="tests.fixture_adapters", mode="live"),
        AdapterEntry(id="rr", module="core.adapters.rr_mock", mode="simulated"),
    )
    await reg.start()
    metrics = {m.key: m for m in await reg.read_all(TS)}
    await reg.stop()

    assert metrics["hr"].state == "error"
    assert metrics["hr"].value is None
    assert metrics["rr"].state == "ok"  # 옆 어댑터는 멀쩡하다


async def test_missing_module_becomes_no_adapter_card() -> None:
    reg = _registry(
        AdapterEntry(id="rppg", module="core.adapters.not_built_yet", mode="live", provides=["hr"])
    )
    await reg.start()
    (metric,) = await reg.read_all(TS)
    await reg.stop()

    assert metric.state == "no_adapter"
    assert metric.mode == "unavailable"
    assert metric.value is None


async def test_unavailable_mode_reads_provides_from_the_class() -> None:
    """모듈이 있으면 config에 provides를 또 적지 않아도 카드 자리가 생긴다."""
    reg = _registry(
        AdapterEntry(id="posture", module="core.adapters.posture_mock", mode="unavailable")
    )
    await reg.start()
    (metric,) = await reg.read_all(TS)
    await reg.stop()

    assert metric.key == "posture"
    assert metric.state == "no_adapter"


async def test_all_metrics_share_the_caller_timestamp() -> None:
    """어댑터가 자기 시계로 찍어도 registry가 서버 시계로 덮어쓴다 (README §2)."""
    reg = _registry(
        AdapterEntry(id="rr", module="core.adapters.rr_mock", mode="simulated"),
        AdapterEntry(id="posture", module="core.adapters.posture_mock", mode="simulated"),
        AdapterEntry(id="rppg", module="core.adapters.not_built_yet", mode="live", provides=["hr"]),
    )
    await reg.start()
    metrics = await reg.read_all(TS)
    await reg.stop()

    assert len(metrics) == 3
    assert {m.ts for m in metrics} == {TS}


async def test_card_order_follows_config_order() -> None:
    reg = _registry(
        AdapterEntry(id="rppg", module="core.adapters.not_built_yet", mode="live", provides=["hr"]),
        AdapterEntry(id="rr", module="core.adapters.rr_mock", mode="simulated"),
    )
    await reg.start()
    metrics = await reg.read_all(TS)
    await reg.stop()

    assert [m.key for m in metrics] == ["hr", "rr"]


async def test_mock_config_runs_the_whole_pipeline_without_hardware() -> None:
    """하드웨어 0개로 지표·액추에이터·정책이 전부 올라온다."""
    reg = Registry.from_yaml(REPO_ROOT / "config" / "device.mock.yaml")
    await reg.start()
    metrics = await reg.read_all(server_now())
    actuators, policies = dict(reg.actuators), list(reg.policies)
    await reg.stop()

    assert [m.key for m in metrics] == [
        "temp", "humidity", "lux", "occupancy", "hr", "rr", "posture",
    ]
    # 전부 합성값이다. 하나라도 live 로 새면 데모에서 실측이라고 오해된다.
    assert {m.mode for m in metrics} == {"simulated"}
    assert "room_light" in actuators
    assert [p.level for p in policies] == ["L1"]


async def test_rr_mock_holds_the_value_when_quality_is_low() -> None:
    """품질 미달이면 값을 지어내지 않고 None으로 보류한다 (README §0-4)."""
    adapter = RespirationMock(id="rr", mode="simulated", low_quality_every=3)
    await adapter.start()

    reads = []
    for _ in range(6):
        (metric,) = await adapter.read()
        reads.append((metric.state, metric.value))

    held = [value for state, value in reads if state == "low_quality"]
    assert len(held) == 2
    assert all(value is None for value in held)


@pytest.mark.parametrize("bad", [-0.1, 1.1])
def test_confidence_outside_zero_to_one_is_rejected(bad: float) -> None:
    with pytest.raises(ValueError):
        Metric(
            key="hr",
            value=70.0,
            unit="bpm",
            source="x",
            mode="live",
            state="ok",
            confidence=bad,
            ts=TS,
        )
