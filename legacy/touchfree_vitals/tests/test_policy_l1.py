"""L1 조명 개입의 판단 로직.

하드웨어 없이 도는 테스트다. 정책이 언제 발화하고 언제 참는지는 이 프로젝트에서
제일 되돌리기 어려운 실수라 (남의 집 불을 켜거나, 자는 사람을 깨우거나) 조건을
하나씩 못 박아 둔다.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pytest

from actuators.tuya_plug import TuyaPlug
from api.schemas import Metric, Snapshot
from core import sim_room
from core.policy.l1_light import L1Light
from core.policy.runner import PolicyRunner
from core.thresholds import Thresholds, load

REPO_ROOT = Path(__file__).resolve().parents[1]

# 야간(22~07시)을 피한 낮 시각. 로컬 시간대로 판단하므로 로컬 정오를 UTC 로 바꾼다.
NOON = datetime.now().astimezone().replace(hour=12, minute=0, second=0, microsecond=0)
MIDNIGHT = NOON.replace(hour=1)


@pytest.fixture(autouse=True)
def clean_room() -> None:
    sim_room.reset()


@pytest.fixture
def thresholds() -> Thresholds:
    return load(REPO_ROOT / "config" / "thresholds.yaml")


def snapshot(*, confidence: float | None, lux: float | None, at: datetime = NOON) -> Snapshot:
    metrics = [
        Metric(
            key="hr", value=None if confidence is None else 70.0, unit="bpm", source="rppg",
            mode="simulated", state="ok", confidence=confidence, ts=at,
        )
    ]
    if lux is not None:
        metrics.append(
            Metric(
                key="lux", value=lux, unit="lx", source="env",
                mode="simulated", state="ok", confidence=None, ts=at,
            )
        )
    return Snapshot(device_id="t", ts=at, metrics=metrics, interventions=[])


def plug() -> TuyaPlug:
    return TuyaPlug(id="room_light", mode="simulated", simulated_lux_gain=120.0)


def make(thresholds: Thresholds, switch: TuyaPlug | None = None) -> L1Light:
    return L1Light(thresholds, {"room_light": switch} if switch else {})


# --- 발화 조건 ---------------------------------------------------------------- #


def test_fires_when_dark_and_confidence_low(thresholds: Thresholds) -> None:
    policy = make(thresholds, plug())
    assert policy.should_fire(snapshot(confidence=0.2, lux=20.0))
    assert "조도" in policy.last_reason


def test_holds_when_bright_even_if_confidence_low(thresholds: Thresholds) -> None:
    """밝은데 신뢰도가 낮으면 원인이 조명이 아니다. 불을 켜도 안 낫는다."""
    policy = make(thresholds, plug())
    assert not policy.should_fire(snapshot(confidence=0.2, lux=300.0))
    assert not policy.near_miss  # 주 조건 자체가 안 맞았다


def test_holds_when_confidence_is_fine(thresholds: Thresholds) -> None:
    policy = make(thresholds, plug())
    assert not policy.should_fire(snapshot(confidence=0.9, lux=10.0))


def test_night_mode_blocks_and_is_recorded(thresholds: Thresholds) -> None:
    """자는 사람을 깨우는 개입은 그 자체로 해롭다 (README §5)."""
    policy = make(thresholds, plug())
    assert not policy.should_fire(snapshot(confidence=0.2, lux=20.0, at=MIDNIGHT))
    assert policy.near_miss  # 조건은 맞았다 — 민감도 조정 때 필요한 기록
    assert "야간" in policy.last_reason


def test_holds_without_actuator(thresholds: Thresholds) -> None:
    policy = make(thresholds, None)
    assert not policy.should_fire(snapshot(confidence=0.2, lux=20.0))
    assert policy.near_miss


async def test_holds_when_light_already_on(thresholds: Thresholds) -> None:
    switch = plug()
    await switch.start()
    await switch.turn_on()
    policy = make(thresholds, switch)
    assert not policy.should_fire(snapshot(confidence=0.2, lux=20.0))
    assert "이미 켜져" in policy.last_reason


def test_ignores_metrics_that_are_not_ok(thresholds: Thresholds) -> None:
    """품질 미달인 조도로 개입을 결정하면 그 개입이 근거를 잃는다."""
    policy = make(thresholds, plug())
    snap = snapshot(confidence=0.2, lux=20.0)
    degraded = snap.metrics[1].model_copy(update={"state": "error"})
    snap = snap.model_copy(update={"metrics": [snap.metrics[0], degraded]})
    assert not policy.should_fire(snap)
    assert "조도 지표가 없다" in policy.last_reason


# --- 발화와 평가 -------------------------------------------------------------- #


async def test_fire_turns_on_light_and_records_before(thresholds: Thresholds) -> None:
    switch = plug()
    await switch.start()
    policy = make(thresholds, switch)
    snap = snapshot(confidence=0.2, lux=20.0)
    policy.should_fire(snap)

    event = await policy.fire(snap)

    assert switch.is_on
    assert event.level == "L1"
    assert event.action == "light_up"
    assert event.before == {"hr_confidence": 0.2, "lux": 20.0}
    assert event.after is None  # 아직 평가 전
    assert event.ts == snap.ts


async def test_evaluate_fills_after(thresholds: Thresholds) -> None:
    switch = plug()
    await switch.start()
    policy = make(thresholds, switch)
    fired = await policy.fire(snapshot(confidence=0.2, lux=20.0))

    later = snapshot(confidence=0.85, lux=150.0, at=NOON + timedelta(seconds=20))
    settled = await policy.evaluate(fired, later)

    assert settled.after == {"hr_confidence": 0.85, "lux": 150.0}
    assert settled.id == fired.id


async def test_evaluate_leaves_after_none_when_nothing_measurable(
    thresholds: Thresholds,
) -> None:
    """'측정했는데 0'과 '측정 못 함'은 다르다 (README §0-4)."""
    policy = make(thresholds, plug())
    fired = await policy.fire(snapshot(confidence=0.2, lux=20.0))
    settled = await policy.evaluate(fired, snapshot(confidence=None, lux=None))
    assert settled.after is None


# --- 실행기 ------------------------------------------------------------------- #


async def test_runner_respects_cooldown(thresholds: Thresholds) -> None:
    switch = plug()
    await switch.start()
    policy = make(thresholds, switch)
    runner = PolicyRunner([policy])

    await runner.tick(snapshot(confidence=0.2, lux=20.0))
    assert len(runner.recent) == 1

    # 불을 껐다 쳐도 쿨다운 안에서는 다시 켜지 않는다.
    await switch.turn_off()
    await runner.tick(snapshot(confidence=0.2, lux=20.0))
    assert len(runner.recent) == 1


async def test_runner_evaluates_after_window(thresholds: Thresholds) -> None:
    switch = plug()
    await switch.start()
    policy = make(thresholds, switch)
    policy.evaluate_after_s = 0  # 즉시 평가
    runner = PolicyRunner([policy])

    await runner.tick(snapshot(confidence=0.2, lux=20.0))
    await runner.tick(snapshot(confidence=0.85, lux=150.0))

    (event,) = runner.recent
    assert event.after == {"hr_confidence": 0.85, "lux": 150.0}


async def test_runner_survives_a_broken_policy(thresholds: Thresholds) -> None:
    """정책 하나가 터져도 나머지는 계속 돈다 (README §0-3)."""

    class Boom(L1Light):
        def should_fire(self, snapshot: Snapshot) -> bool:
            raise RuntimeError("정책 폭발")

    switch = plug()
    await switch.start()
    good = make(thresholds, switch)
    runner = PolicyRunner([Boom(thresholds, {}), good])

    await runner.tick(snapshot(confidence=0.2, lux=20.0))
    assert len(runner.recent) == 1
