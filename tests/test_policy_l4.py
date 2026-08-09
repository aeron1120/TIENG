"""L4 보호자 알림.

핵심은 "언제 보내는가"가 아니라 **"언제 안 보내는가"**다. 메일은 되돌릴 수 없다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from api.schemas import InterventionEvent, Metric, Snapshot
from core.policy.l4_guardian import L4Guardian
from core.policy.runner import PolicyRunner
from core.thresholds import HrBand, NightMode, Thresholds


class FakeNotifier:
    id = "guardian_email"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def notify(self, subject: str, body: str) -> None:
        self.sent.append((subject, body))


def _thresholds(**policy: object) -> Thresholds:
    return Thresholds(
        profile="test",
        hr=HrBand(low=55, high=95, sustain_s=2),
        confidence_min=0.4,
        night_mode=NightMode(start="22:00", end="07:00"),
        policies={"l4_guardian": {"cancel_window_s": 30, "lost_sustain_s": 2, **policy}},
    )


def _snapshot(*, hr: float | None, occupied: float = 1.0, state: str = "ok") -> Snapshot:
    ts = datetime.now(UTC)
    metrics = [
        Metric(key="occupancy", value=occupied, unit=None, source="pir", mode="simulated",
               state="ok", confidence=None, ts=ts),
        Metric(key="hr", value=hr, unit="bpm", source="rppg", mode="simulated",
               state="ok" if hr is not None else state, confidence=0.9, ts=ts),
    ]
    return Snapshot(device_id="tfv-test", ts=ts, metrics=metrics, interventions=[])


def _policy(notifier: FakeNotifier | None, **policy: object) -> L4Guardian:
    actuators = {"guardian_email": notifier} if notifier else {}
    return L4Guardian(_thresholds(**policy), actuators)  # type: ignore[arg-type]


# --- 발화 조건 ------------------------------------------------------------- #


def test_empty_room_never_fires() -> None:
    """아무도 없는 방의 심박수는 이상한 게 정상이다."""
    policy = _policy(FakeNotifier(), triggers=["abnormal_hr"])
    assert policy.should_fire(_snapshot(hr=200, occupied=0.0)) is False
    assert "사람이 없다" in policy.last_reason


def test_a_single_bad_reading_does_not_fire() -> None:
    """한 틱 튄 값으로 보호자를 부르지 않는다. 지속돼야 한다."""
    policy = _policy(FakeNotifier(), triggers=["abnormal_hr"])
    assert policy.should_fire(_snapshot(hr=140)) is False
    assert "지속되지 않았다" in policy.last_reason


def test_sustained_abnormal_hr_fires(monkeypatch: pytest.MonkeyPatch) -> None:
    policy = _policy(FakeNotifier(), triggers=["abnormal_hr"])
    clock = [1000.0]
    monkeypatch.setattr("core.policy.l4_guardian.time.monotonic", lambda: clock[0])

    assert policy.should_fire(_snapshot(hr=140)) is False  # 타이머 시작
    clock[0] += 3.0  # sustain_s = 2
    assert policy.should_fire(_snapshot(hr=140)) is True
    assert "정상 대역" in policy.last_reason


def test_recovery_resets_the_timer(monkeypatch: pytest.MonkeyPatch) -> None:
    """중간에 정상으로 돌아오면 처음부터 다시 센다."""
    policy = _policy(FakeNotifier(), triggers=["abnormal_hr"])
    clock = [1000.0]
    monkeypatch.setattr("core.policy.l4_guardian.time.monotonic", lambda: clock[0])

    policy.should_fire(_snapshot(hr=140))
    clock[0] += 1.5
    policy.should_fire(_snapshot(hr=70))  # 정상 복귀
    clock[0] += 1.5
    assert policy.should_fire(_snapshot(hr=140)) is False  # 다시 0 부터


def test_production_profile_ignores_measurement_lost(monkeypatch: pytest.MonkeyPatch) -> None:
    """실사용에서는 측정 실패로 보호자를 부르지 않는다 (thresholds.yaml 이 정한다)."""
    policy = _policy(FakeNotifier(), triggers=["abnormal_hr"])
    clock = [1000.0]
    monkeypatch.setattr("core.policy.l4_guardian.time.monotonic", lambda: clock[0])

    for _ in range(5):
        clock[0] += 2.0
        assert policy.should_fire(_snapshot(hr=None, state="low_quality")) is False


def test_dev_profile_catches_measurement_lost(monkeypatch: pytest.MonkeyPatch) -> None:
    policy = _policy(FakeNotifier(), triggers=["abnormal_hr", "measurement_lost"])
    clock = [1000.0]
    monkeypatch.setattr("core.policy.l4_guardian.time.monotonic", lambda: clock[0])

    assert policy.should_fire(_snapshot(hr=None, state="low_quality")) is False
    clock[0] += 3.0  # lost_sustain_s = 2
    assert policy.should_fire(_snapshot(hr=None, state="low_quality")) is True
    assert "측정하지 못함" in policy.last_reason


def test_missing_notifier_is_a_near_miss(monkeypatch: pytest.MonkeyPatch) -> None:
    """자격증명이 없으면 액추에이터가 안 올라온다. 그 사실이 기록에 남아야 한다."""
    policy = _policy(None, triggers=["abnormal_hr"])
    clock = [1000.0]
    monkeypatch.setattr("core.policy.l4_guardian.time.monotonic", lambda: clock[0])

    policy.should_fire(_snapshot(hr=140))
    clock[0] += 3.0
    assert policy.should_fire(_snapshot(hr=140)) is False
    assert policy.near_miss is True
    assert "연결돼 있지 않다" in policy.last_reason


# --- 취소 창 --------------------------------------------------------------- #


async def test_fire_does_not_send_yet() -> None:
    """발화는 카운트다운 시작일 뿐이다. 여기서 보내면 취소할 수가 없다."""
    notifier = FakeNotifier()
    policy = _policy(notifier, triggers=["abnormal_hr"])

    event = await policy.fire(_snapshot(hr=140))

    assert notifier.sent == []
    assert event.accepted is None  # 사용자 확인 대기
    assert event.action == "notify_guardian"


async def test_evaluate_sends_when_not_cancelled() -> None:
    notifier = FakeNotifier()
    policy = _policy(notifier, triggers=["abnormal_hr"])

    event = await policy.fire(_snapshot(hr=140))
    settled = await policy.evaluate(event, _snapshot(hr=140))

    assert len(notifier.sent) == 1
    assert settled.accepted is True
    subject, body = notifier.sent[0]
    assert "tfv-test" in subject
    assert "의료 진단이 아니며" in body  # README §1


async def test_cancelled_alert_is_never_sent() -> None:
    """이 테스트가 이 기능의 존재 이유다."""
    notifier = FakeNotifier()
    policy = _policy(notifier, triggers=["abnormal_hr"])

    event = await policy.fire(_snapshot(hr=140))
    cancelled = event.model_copy(update={"accepted": False})
    settled = await policy.evaluate(cancelled, _snapshot(hr=140))

    assert notifier.sent == []
    assert settled.accepted is False


async def test_runner_cancels_only_while_pending() -> None:
    notifier = FakeNotifier()
    policy = _policy(notifier, triggers=["abnormal_hr"])
    runner = PolicyRunner([policy])

    pending = InterventionEvent(
        id="abc123", level="L4", action="notify_guardian", trigger="테스트",
        before={}, after=None, accepted=None, ts=datetime.now(UTC) - timedelta(seconds=1),
    )
    runner._pending.append((policy, pending, 1e18))  # 아직 평가 전
    runner._recent.append(pending)

    assert runner.cancel("abc123") is True
    assert runner.recent[0].accepted is False
    assert runner.cancel("없는id") is False
