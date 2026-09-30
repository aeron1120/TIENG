"""졸음 단계별 순차 알림.

핵심은 "얼마나 이어져야 올라가는가"다. 한 틱 튄 판정으로 보호자를 부르면 그
알림은 다음부터 아무도 보지 않는다.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from api.schemas import Metric, Snapshot
from core.policy.drowsy_ladder import DrowsyLadder
from core.policy.l4_guardian import L4Guardian
from core.policy.runner import PolicyRunner
from core.thresholds import HrBand, NightMode, Thresholds


class FakeSwitch:
    id = "room_light"

    def __init__(self) -> None:
        self.on = False

    @property
    def is_on(self) -> bool:
        return self.on

    async def turn_on(self) -> None:
        self.on = True

    async def turn_off(self) -> None:
        self.on = False


class FakeNotifier:
    id = "guardian_email"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def notify(self, subject: str, body: str) -> None:
        self.sent.append((subject, body))


def _thresholds() -> Thresholds:
    return Thresholds(
        profile="test",
        hr=HrBand(low=55, high=95, sustain_s=2),
        confidence_min=0.4,
        night_mode=NightMode(start="22:00", end="07:00"),
        policies={
            "drowsy_ladder": {
                "notice": {"sustain_s": 2},
                "alert": {"sustain_s": 5},
                "guardian": {"sustain_s": 10, "cancel_window_s": 30},
            }
        },
    )


def _snapshot(verdict: str | None, *, state: str = "ok", score: float = 72.0) -> Snapshot:
    ts = datetime.now(UTC)
    metrics = [
        Metric(key="drowsy_score", value=score, unit=None, source="drowsiness",
               mode="live", state="ok", confidence=0.8, ts=ts),
    ]
    if verdict is not None:
        metrics.append(
            Metric(key="drowsiness", value=verdict, unit=None, source="drowsiness",
                   mode="live", state=state, confidence=0.8, ts=ts)
        )
    return Snapshot(device_id="tfv-test", ts=ts, metrics=metrics, interventions=[])


def _rung(
    name: str,
    *,
    switch: FakeSwitch | None = None,
    notifier: FakeNotifier | None = None,
) -> DrowsyLadder:
    actuators: dict[str, object] = {}
    if switch is not None:
        actuators["room_light"] = switch
    if notifier is not None:
        actuators["guardian_email"] = notifier
    return DrowsyLadder(_thresholds(), actuators, rung=name)  # type: ignore[arg-type]


def _clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    now = [1000.0]
    monkeypatch.setattr("core.policy.drowsy_ladder.time.monotonic", lambda: now[0])
    return now


# --- 칸의 모양 ------------------------------------------------------------- #


def test_each_rung_declares_its_own_level_and_reversibility() -> None:
    """화면의 취소 창이 (level, reversible) 표를 보고 뜬다. 칸마다 달라야 한다."""
    assert (_rung("notice").level, _rung("notice").reversible) == ("L2", True)
    assert (_rung("alert").level, _rung("alert").reversible) == ("L3", True)
    assert (_rung("guardian").level, _rung("guardian").reversible) == ("L4", False)


def test_unknown_rung_fails_loudly() -> None:
    """오타가 조용히 기본 칸으로 떨어지면 사다리 하나가 통째로 없어진다."""
    with pytest.raises(ValueError, match="모르는 단계"):
        DrowsyLadder(_thresholds(), {}, rung="warn")


# --- 발화 조건 ------------------------------------------------------------- #


def test_no_verdict_never_fires() -> None:
    """졸음 어댑터가 없거나 쉬는 중이면 판정이 없다. 없는 근거로 알리지 않는다."""
    policy = _rung("notice")
    assert policy.should_fire(_snapshot(None)) is False
    assert "판정이 없다" in policy.last_reason


def test_low_quality_verdict_is_not_a_verdict() -> None:
    """카메라가 얼굴을 놓친 동안의 판정으로 단계를 올리지 않는다."""
    policy = _rung("notice")
    assert policy.should_fire(_snapshot("drowsy", state="low_quality")) is False
    assert "판정이 없다" in policy.last_reason


def test_awake_does_not_start_the_ladder() -> None:
    policy = _rung("notice")
    assert policy.should_fire(_snapshot("awake")) is False
    assert "warning 에 못 미친다" in policy.last_reason


def test_notice_needs_the_verdict_to_persist(monkeypatch: pytest.MonkeyPatch) -> None:
    """한 틱 튄 관심 판정으로 경고하지 않는다."""
    policy = _rung("notice")
    clock = _clock(monkeypatch)

    assert policy.should_fire(_snapshot("warning")) is False
    assert "이어져야 한다" in policy.last_reason
    clock[0] += 3.0  # sustain_s = 2
    assert policy.should_fire(_snapshot("warning")) is True


def test_waking_up_resets_the_timer(monkeypatch: pytest.MonkeyPatch) -> None:
    """중간에 깨면 처음부터 다시 센다. 하루 종일 쌓인 시간으로 알리지 않는다."""
    policy = _rung("notice")
    clock = _clock(monkeypatch)

    policy.should_fire(_snapshot("warning"))
    clock[0] += 1.5
    policy.should_fire(_snapshot("awake"))
    clock[0] += 1.5
    assert policy.should_fire(_snapshot("warning")) is False


def test_alert_ignores_mere_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    """위험 칸은 관심 판정으로는 아무리 오래 기다려도 오르지 않는다."""
    policy = _rung("alert", switch=FakeSwitch())
    clock = _clock(monkeypatch)

    for _ in range(5):
        clock[0] += 10.0
        assert policy.should_fire(_snapshot("warning")) is False
    assert "drowsy 에 못 미친다" in policy.last_reason


def test_rungs_climb_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """지속 시간이 순서를 만든다 — 위험이 계속되면 관심 → 위험 → 보호자 순이다."""
    notice = _rung("notice")
    alert = _rung("alert", switch=FakeSwitch())
    guardian = _rung("guardian", notifier=FakeNotifier())
    clock = _clock(monkeypatch)

    fired: list[str] = []
    for _ in range(13):
        clock[0] += 1.0
        for name, policy in (("L2", notice), ("L3", alert), ("L4", guardian)):
            if name not in fired and policy.should_fire(_snapshot("drowsy")):
                fired.append(name)

    assert fired == ["L2", "L3", "L4"]


def test_missing_light_is_a_near_miss(monkeypatch: pytest.MonkeyPatch) -> None:
    """조명이 안 붙은 이유가 기록에 남아야 나중에 민감도를 조정할 수 있다."""
    policy = _rung("alert")
    clock = _clock(monkeypatch)

    policy.should_fire(_snapshot("drowsy"))
    clock[0] += 6.0
    assert policy.should_fire(_snapshot("drowsy")) is False
    assert policy.near_miss is True
    assert "연결돼 있지 않다" in policy.last_reason


def test_notice_does_not_need_any_actuator(monkeypatch: pytest.MonkeyPatch) -> None:
    """화면 경고는 액추에이터가 필요 없다. 없다고 보류되면 안 된다."""
    policy = _rung("notice")
    clock = _clock(monkeypatch)

    policy.should_fire(_snapshot("warning"))
    clock[0] += 3.0
    assert policy.should_fire(_snapshot("warning")) is True


# --- 발화와 평가 ----------------------------------------------------------- #


async def test_alert_turns_the_light_on() -> None:
    switch = FakeSwitch()
    policy = _rung("alert", switch=switch)

    event = await policy.fire(_snapshot("drowsy"))

    assert switch.is_on is True
    assert event.level == "L3"
    assert event.before["drowsy_score"] == 72.0


async def test_guardian_does_not_send_on_fire() -> None:
    """발화는 카운트다운 시작일 뿐이다. 여기서 보내면 취소할 수가 없다."""
    notifier = FakeNotifier()
    policy = _rung("guardian", notifier=notifier)

    event = await policy.fire(_snapshot("drowsy"))

    assert notifier.sent == []
    assert event.accepted is None


async def test_guardian_sends_after_the_window() -> None:
    notifier = FakeNotifier()
    policy = _rung("guardian", notifier=notifier)

    event = await policy.fire(_snapshot("drowsy"))
    settled = await policy.evaluate(event, _snapshot("drowsy"))

    assert len(notifier.sent) == 1
    assert settled.accepted is True


async def test_cancelled_guardian_never_sends() -> None:
    notifier = FakeNotifier()
    policy = _rung("guardian", notifier=notifier)

    event = await policy.fire(_snapshot("drowsy"))
    cancelled = event.model_copy(update={"accepted": False})
    settled = await policy.evaluate(cancelled, _snapshot("awake"))

    assert notifier.sent == []
    assert settled.accepted is False


async def test_screen_rungs_never_send_anything() -> None:
    """L2 는 화면에 뜨는 것이 전부다. 평가에서 무언가 나가면 안 된다."""
    notifier = FakeNotifier()
    policy = _rung("notice", notifier=notifier)

    event = await policy.fire(_snapshot("warning"))
    await policy.evaluate(event, _snapshot("warning"))

    assert notifier.sent == []


# --- 실행기 --------------------------------------------------------------- #


async def test_two_policies_at_the_same_level_do_not_share_a_cooldown() -> None:
    """졸음 L4 와 심박 L4 는 서로 다른 정책이다. 하나가 다른 하나를 막으면 안 된다."""
    drowsy = _rung("guardian", notifier=FakeNotifier())
    hr = L4Guardian(
        Thresholds(
            profile="test",
            hr=HrBand(low=55, high=95, sustain_s=0),
            confidence_min=0.4,
            night_mode=NightMode(start="22:00", end="07:00"),
            policies={"l4_guardian": {"triggers": ["abnormal_hr"], "cooldown_s": 600}},
        ),
        {"guardian_email": FakeNotifier()},  # type: ignore[dict-item]
    )
    runner = PolicyRunner([drowsy, hr])

    ts = datetime.now(UTC)
    snapshot = Snapshot(
        device_id="tfv-test",
        ts=ts,
        metrics=[
            Metric(key="drowsiness", value="drowsy", unit=None, source="drowsiness",
                   mode="live", state="ok", confidence=0.8, ts=ts),
            Metric(key="occupancy", value=1.0, unit=None, source="pir",
                   mode="simulated", state="ok", confidence=None, ts=ts),
            Metric(key="hr", value=140.0, unit="bpm", source="rppg",
                   mode="live", state="ok", confidence=0.9, ts=ts),
        ],
        interventions=[],
    )

    drowsy.sustain_s = 0.0
    await runner.tick(snapshot)
    await runner.tick(snapshot)

    levels = [e.level for e in runner.recent]
    assert levels.count("L4") == 2  # 졸음 하나, 심박 하나
