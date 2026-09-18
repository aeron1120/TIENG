import csv
from datetime import UTC, datetime
from pathlib import Path

from api.schemas import Metric, Snapshot
from core.csv_logs import METRIC_COLUMNS, MetricCsvLogger

TS = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)


def _snapshot() -> Snapshot:
    return Snapshot(
        device_id="tfv-01",
        ts=TS,
        metrics=[
            Metric(
                key="hr", value=72.4, unit="bpm", source="rppg",
                mode="live", state="ok", confidence=0.81, ts=TS,
            ),
            Metric(
                key="rr", value=None, unit="rpm", source="rr_estimator",
                mode="simulated", state="low_quality", confidence=0.2, ts=TS,
            ),
        ],
        interventions=[],
    )


def test_writes_header_once_and_appends(tmp_path: Path) -> None:
    path = tmp_path / "logs" / "metrics.csv"
    for _ in range(2):
        logger = MetricCsvLogger(path)
        logger.open()
        logger.write_snapshot(_snapshot())
        logger.close()

    rows = list(csv.reader(path.read_text(encoding="utf-8").splitlines()))
    assert rows[0] == METRIC_COLUMNS
    assert len(rows) == 1 + 4  # 헤더 1 + 스냅샷 2회 x 지표 2개


def test_held_values_are_kept_as_empty_not_zero(tmp_path: Path) -> None:
    """보류 행이 남아야 나중에 보류율을 셀 수 있다 (README §8)."""
    path = tmp_path / "metrics.csv"
    logger = MetricCsvLogger(path)
    logger.open()
    logger.write_snapshot(_snapshot())
    logger.close()

    rows = list(csv.DictReader(path.read_text(encoding="utf-8").splitlines()))
    held = [r for r in rows if r["key"] == "rr"][0]
    assert held["value"] == ""
    assert held["state"] == "low_quality"
    assert held["confidence"] == "0.200"


def test_all_rows_share_the_snapshot_timestamp(tmp_path: Path) -> None:
    """지표 로그와 개입 로그를 join 하려면 같은 ts 축이어야 한다 (README §8)."""
    path = tmp_path / "metrics.csv"
    logger = MetricCsvLogger(path)
    logger.open()
    logger.write_snapshot(_snapshot())
    logger.close()

    rows = list(csv.DictReader(path.read_text(encoding="utf-8").splitlines()))
    assert {r["ts"] for r in rows} == {TS.isoformat()}
