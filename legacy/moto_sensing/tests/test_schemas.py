"""스키마 왕복 + 설정 로딩 (CLAUDE.md §13-1).

왕복만 보는 테스트가 아니다. 이 프로젝트에서 스키마가 지켜야 하는 것은 "없는 값이
없는 채로 남는가" 이고 (§0-4), 그게 깨지면 야간 구간 전체가 0 으로 기록된다.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core import config
from core.quality import combine
from core.schemas import CamMetrics, Event, ImuSample, RuleTrace

CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "default.yaml"


def test_imu_sample_roundtrip() -> None:
    sample = ImuSample(
        t=1.5, ax=0.1, ay=0.2, az=9.8, gx=0.0, gy=0.0, gz=0.01, seq=42, source="sim"
    )
    assert ImuSample.model_validate_json(sample.model_dump_json()) == sample


def test_none_survives_roundtrip() -> None:
    """값을 못 구했으면 못 구한 채로 간다. 0 으로 대체되면 §0-4 가 깨진다."""
    metrics = CamMetrics(
        t=0.0,
        frame_id=1,
        roll_cam=None,
        roll_sqi=0.0,
        flow_speed=None,
        flow_sqi=0.0,
        flow_n_inliers=0,
        flow_residual=0.0,
        mean_luma=12.0,
        exposure_us=8000,
    )
    back = CamMetrics.model_validate_json(metrics.model_dump_json())
    assert back.roll_cam is None
    assert back.flow_speed is None


def test_blocked_rule_is_not_a_rejection() -> None:
    """판정 불가와 기각은 다른 결과다 (§6.7). 둘 다 fired=False 라 구분이 여기뿐이다."""
    blocked = RuleTrace(
        rule="impact_trigger",
        fired=False,
        inputs={"delta_v": None},
        thresholds={"delta_v_min": 3.33},
        blocked_by="low_quality",
    )
    rejected = RuleTrace(
        rule="impact_trigger",
        fired=False,
        inputs={"delta_v": 0.4},
        thresholds={"delta_v_min": 3.33},
    )
    assert blocked.blocked_by is not None
    assert rejected.blocked_by is None

    event = Event(id="e1", t=12.0, kind="reject", traces=[blocked, rejected])
    assert Event.model_validate_json(event.model_dump_json()) == event


def test_default_config_loads() -> None:
    cfg = config.load(CONFIG_PATH)
    assert cfg.device_id == "pi5-01"
    assert cfg.fusion.loop_hz == 50
    assert cfg.adapters.imu.odr_hz == 1000


def test_detection_stays_off() -> None:
    """§10, §14: Phase 1 에서는 절대 true 로 두지 말 것."""
    assert config.load(CONFIG_PATH).detection.enabled is False


def test_unknown_key_is_rejected(tmp_path: Path) -> None:
    """오타난 키가 조용히 기본값으로 떨어지면 그 세션은 통째로 쓸모없어진다."""
    text = CONFIG_PATH.read_text(encoding="utf-8").replace("loop_hz: 50", "loop_hertz: 50")
    bad = tmp_path / "typo.yaml"
    bad.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError):
        config.load(bad)


def test_combine_is_dragged_down_by_worst_component() -> None:
    """산술평균이면 0.5 로 통과한다. 그걸 막으려고 기하평균을 쓴다."""
    weights = {"inliers": 1.0, "residual": 1.0}
    assert combine({"inliers": 1.0, "residual": 0.0}, weights) < 0.01


def test_combine_skips_unmeasured_components() -> None:
    """잴 수 없는 성분이 confidence 를 깎지 않는다."""
    weights = {"inliers": 1.0, "residual": 1.0}
    assert combine({"inliers": 0.8}, weights) == pytest.approx(0.8)


def test_cloud_config_records_nothing_and_detects_nothing() -> None:
    """Render 에 올라가는 설정. 공개 주소라 둘 다 꺼져 있어야 한다."""
    cfg = config.load(CONFIG_PATH.parent / "cloud.yaml")

    assert cfg.recording.enabled is False
    assert cfg.detection.enabled is False
    # 붙어 있지 않은 것을 켜 두면 값을 지어낼 자리가 생긴다 (§0-4).
    assert cfg.adapters.camera.enabled is False
    assert cfg.adapters.phone.enabled is False
