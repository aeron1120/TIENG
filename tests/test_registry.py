"""registry가 README §0-3 (어댑터가 죽어도 파이프라인은 돈다) 를 지키는지."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from api.schemas import Metric, server_now
from core.adapters.rr_mock import RespirationMock
from core.overrides import Overrides
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
    assert [p.level for p in policies] == ["L1", "L4"]


# --- 카메라 backend 교체 ------------------------------------------------------ #
# CSI 가 안 열릴 때 화면에서 opencv 로 바꿔 본다. 파이에 ssh 로 붙어 device.yaml 을
# 고치고 서비스를 재시작하는 왕복을 없애는 것이 목적이라, 어댑터 하나만 갈아 끼우고
# 나머지 카드와 샘플 루프는 계속 돌아야 한다.


@pytest.fixture
def camera_module(monkeypatch: pytest.MonkeyPatch) -> None:
    """카메라로 취급할 모듈을 가짜로 바꾼다 (tests/fixture_camera.py 에 이유)."""
    monkeypatch.setattr("core.registry.CAMERA_MODULE", "tests.fixture_camera")


def _camera(backend: str) -> AdapterEntry:
    return AdapterEntry(
        id="cam", module="tests.fixture_camera", mode="live", params={"backend": backend}
    )


async def test_restart_reopens_the_camera_with_the_new_backend(camera_module: None) -> None:
    """picamera2 가 안 열리는 기기에서 opencv 로 바꾸면 그 카드만 살아난다."""
    reg = _registry(_camera("picamera2"), AdapterEntry(id="rr", module="core.adapters.rr_mock"))
    await reg.start()
    assert reg.status()["adapters"][0]["state"] == "failed"

    reg.set_camera_backend("opencv")
    await reg.restart_adapter("cam")
    metrics = {m.key: m for m in await reg.read_all(TS)}
    status = reg.status()
    await reg.stop()

    assert status["camera_backend"] == "opencv"
    assert status["adapters"][0]["state"] == "running"
    assert status["adapters"][0]["detail"] == ""  # 옛 실패 사유가 남으면 안 된다
    assert metrics["hr"].value == 70.0
    assert metrics["rr"].state == "ok"  # 옆 어댑터는 건드리지 않는다


async def test_restart_that_fails_leaves_the_reason_on_the_card(camera_module: None) -> None:
    """안 열리는 것을 확인하는 것도 바꿔 보는 이유다. 사유가 화면까지 와야 한다."""
    reg = _registry(_camera("opencv"))
    await reg.start()

    reg.set_camera_backend("picamera2")
    await reg.restart_adapter("cam")  # 예외를 올리지 않는다
    (card,) = reg.status()["adapters"]
    (metric,) = await reg.read_all(TS)
    await reg.stop()

    assert card["state"] == "failed"
    assert "camera_index=0" in card["detail"]
    assert metric.state == "no_adapter"  # 멎은 값을 계속 내보내지 않는다


async def test_saved_backend_overrides_the_yaml(
    camera_module: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """화면에서 고른 값이 재시작 뒤에도 남는다. device.yaml 은 손대지 않는다."""
    config = tmp_path / "device.yaml"
    config.write_text(
        "device_id: t\n"
        "adapters:\n"
        "  - id: cam\n"
        "    module: tests.fixture_camera\n"
        "    params: { backend: picamera2 }\n",
        encoding="utf-8",
    )

    reg = Registry.from_yaml(config, Overrides(camera_backend="opencv"))

    assert reg.camera_backend() == "opencv"
    assert "backend: picamera2" in config.read_text(encoding="utf-8")  # 파일은 그대로


async def test_config_without_a_camera_has_nothing_to_choose() -> None:
    """mock 구성에는 rppg 어댑터가 없다. 화면이 선택칸을 감출 수 있어야 한다."""
    reg = Registry.from_yaml(REPO_ROOT / "config" / "device.mock.yaml")

    assert reg.camera_entry() is None
    assert reg.camera_backend() is None
    with pytest.raises(LookupError):
        reg.set_camera_backend("opencv")


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
