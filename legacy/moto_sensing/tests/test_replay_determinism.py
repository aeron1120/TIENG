"""§9 — 이 프로젝트의 핵심 테스트.

이게 깨지면 지표 튜닝을 주행 없이 할 수 없게 되고 프로젝트가 멈춘다.

지금은 융합·지표가 없어서 검증 대상이 원시 샘플까지다. §13-8·9 가 들어오면
fused.parquet / indicators.parquet 비교를 여기에 더한다.
"""

from __future__ import annotations

from pathlib import Path

from core import config as config_mod
from core.pipeline import Pipeline
from core.recorder import read_stream
from core.schemas import ImuSample

CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "default.yaml"


def _config(session_dir: Path) -> config_mod.Config:
    cfg = config_mod.load(CONFIG_PATH)
    return cfg.model_copy(
        update={"recording": cfg.recording.model_copy(update={"session_dir": str(session_dir)})}
    )


def test_replaying_twice_gives_the_same_thing(tmp_path: Path) -> None:
    recorded = Pipeline(_config(tmp_path / "live"), "sim").run(seconds=0.3)
    source = read_stream(recorded, "imu", ImuSample)
    assert source, "리플레이할 원본이 비어 있다"

    first = Pipeline(_config(tmp_path / "r1"), "replay", recorded).run()
    second = Pipeline(_config(tmp_path / "r2"), "replay", recorded).run()

    a = read_stream(first, "imu", ImuSample)
    b = read_stream(second, "imu", ImuSample)
    assert a == b


def test_replay_loses_no_sample(tmp_path: Path) -> None:
    """한 샘플이라도 버리면 튜닝 결과가 주행마다 달라진다 (§9, adapters/base.push_blocking)."""
    recorded = Pipeline(_config(tmp_path / "live"), "sim").run(seconds=0.3)
    source = read_stream(recorded, "imu", ImuSample)

    replayed = read_stream(
        Pipeline(_config(tmp_path / "r1"), "replay", recorded).run(), "imu", ImuSample
    )
    assert len(replayed) == len(source)
    assert sorted(s.seq for s in replayed) == sorted(s.seq for s in source)


def test_replay_preserves_order(tmp_path: Path) -> None:
    recorded = Pipeline(_config(tmp_path / "live"), "sim").run(seconds=0.3)
    replayed = read_stream(
        Pipeline(_config(tmp_path / "r1"), "replay", recorded).run(), "imu", ImuSample
    )

    assert [s.seq for s in replayed] == sorted(s.seq for s in replayed)


def test_pipeline_does_not_know_it_is_replaying(tmp_path: Path) -> None:
    """실시간과 같은 인터페이스여야 한다 (§4). 다른 것은 mode 뿐이다."""
    recorded = Pipeline(_config(tmp_path / "live"), "sim").run(seconds=0.2)
    pipeline = Pipeline(_config(tmp_path / "r1"), "replay", recorded)
    pipeline.run()

    assert pipeline.latest is not None
    assert pipeline.latest.mode == "replay"
    assert pipeline.latest.indicators == []
