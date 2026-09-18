"""§13-2 검증: 합성 신호로 세션이 생기고 parquet 를 다시 읽을 수 있다."""

from __future__ import annotations

import json
from pathlib import Path

from core import config as config_mod
from core.pipeline import Pipeline
from core.recorder import read_stream, schema_of
from core.schemas import ImuSample

CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "default.yaml"


def _config(tmp_path: Path) -> config_mod.Config:
    cfg = config_mod.load(CONFIG_PATH)
    return cfg.model_copy(
        update={"recording": cfg.recording.model_copy(update={"session_dir": str(tmp_path)})}
    )


def test_sim_session_is_written_and_readable(tmp_path: Path) -> None:
    out = Pipeline(_config(tmp_path), "sim").run(seconds=0.3)

    assert (out / "meta.json").is_file()
    samples = read_stream(out, "imu", ImuSample)
    assert samples, "합성 신호가 한 샘플도 기록되지 않았다"
    assert all(isinstance(s, ImuSample) for s in samples)


def test_meta_carries_config_and_commit(tmp_path: Path) -> None:
    """어떤 설정으로 찍힌 데이터인지 모르면 그 세션은 통째로 못 쓴다 (§8)."""
    out = Pipeline(_config(tmp_path), "sim").run(seconds=0.2)
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))

    assert meta["config"]["fusion"]["loop_hz"] == 50
    assert meta["mode"] == "simulated"
    assert "git_commit" in meta


def test_timestamps_come_from_sample_count(tmp_path: Path) -> None:
    """t 를 읽은 시각으로 찍으면 간격이 흔들린다 (§4, §12 표 첫 줄)."""
    out = Pipeline(_config(tmp_path), "sim").run(seconds=0.3)
    samples = sorted(read_stream(out, "imu", ImuSample), key=lambda s: s.seq)

    step = 1.0 / 1000
    gaps = [b.t - a.t for a, b in zip(samples, samples[1:], strict=False)]
    assert gaps, "간격을 잴 만큼 샘플이 없다"
    assert max(abs(g - step) for g in gaps) < 1e-9


def test_nullable_column_survives_parquet(tmp_path: Path) -> None:
    """temp 가 전부 None 이어도 float 열로 남아야 한다.

    pyarrow 추론에 맡기면 null 타입으로 굳어서, 온도가 실린 배치가 들어오는 순간
    기록이 통째로 실패한다 (core/recorder.py).
    """
    assert str(schema_of(ImuSample).field("temp").type) == "double"

    out = Pipeline(_config(tmp_path), "sim").run(seconds=0.2)
    assert all(s.temp is None for s in read_stream(out, "imu", ImuSample))


def test_snapshot_invents_nothing(tmp_path: Path) -> None:
    """융합도 지표도 없는 단계다. 빈 것을 빈 채로 내보내야 한다 (§0-4)."""
    pipeline = Pipeline(_config(tmp_path), "sim")
    pipeline.run(seconds=0.2)

    assert pipeline.latest is not None
    assert pipeline.latest.fused is None
    assert pipeline.latest.indicators == []
    assert pipeline.latest.mode == "simulated"
    assert pipeline.latest.health["imu_sim.errors"] == 0.0
