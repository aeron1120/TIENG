"""정량 검증 하네스.

아카이브된 실측 세션(legacy/tieng_rppg/validation)의 결과를 재현하는지 본다.
발표에 쓰는 숫자를 내는 코드라, 나중에 고치다 값이 달라지면 여기서 잡혀야 한다.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import validate_vs_oximeter as v  # noqa: E402

DATA = REPO_ROOT / "legacy" / "tieng_rppg" / "validation"


def _pairs(
    demo: str, ref: str, *, ref_warmup: float, demo_warmup: float, tol: float
) -> tuple[np.ndarray, ...]:
    est = v._drop_warmup(v.load_estimate(DATA / demo), demo_warmup)
    reference = v._drop_warmup(v.load_reference(DATA / ref, None, None), ref_warmup)
    offset, _ = v.find_lag(est, reference, max_lag=5.0, step=0.5)
    return v.align(est, reference, tol, offset)


def test_reproduces_archived_static_session() -> None:
    """legacy evaluate.py 가 낸 값과 소수점까지 같아야 한다.

    기준: validation/report/static1/summary.csv
      n=96, bias=-2.57, MAE=3.65, RMSE=4.79, ±5=74.0%, r=0.720
    """
    est, ref, _ = _pairs(
        "static_demo_r1.csv", "static1_ref.csv", ref_warmup=20, demo_warmup=0, tol=2.0
    )
    s = v.stats(est, ref)

    assert s["n"] == 96
    assert s["bias"] == pytest.approx(-2.57, abs=0.01)
    assert s["mae"] == pytest.approx(3.65, abs=0.01)
    assert s["rmse"] == pytest.approx(4.79, abs=0.01)
    assert s["within5"] == pytest.approx(74.0, abs=0.1)
    assert s["pearson"] == pytest.approx(0.720, abs=0.001)


def test_warmup_exclusion_changes_the_result() -> None:
    """옥시미터 초반 구간을 기준으로 쓰면 카메라가 틀린 것처럼 보인다."""
    with_warmup = v.stats(*_pairs(
        "static_demo_r1.csv", "static1_ref.csv", ref_warmup=20, demo_warmup=0, tol=2.0
    )[:2])
    without = v.stats(*_pairs(
        "static_demo_r1.csv", "static1_ref.csv", ref_warmup=0, demo_warmup=0, tol=2.0
    )[:2])

    assert without["n"] > with_warmup["n"]
    assert without["mae"] > with_warmup["mae"]  # 안정화 전 구간이 오차를 키운다


def test_lag_search_uses_correlation_not_error() -> None:
    """상관 최대화라 bias 를 깎지 않는다. 지표를 스스로 좋게 만들면 안 된다."""
    t = np.arange(0, 60, 0.5)
    truth = 70 + 5 * np.sin(2 * np.pi * t / 30)
    est = v.Series(t=t, bpm=truth + 8.0, confidence=np.full(len(t), 0.9))  # +8bpm 편향
    ref = v.Series(t=t + 3.0, bpm=truth, confidence=np.full(len(t), np.nan))

    offset, corr = v.find_lag(est, ref, max_lag=5.0, step=0.5)

    assert offset == pytest.approx(3.0, abs=0.5)  # 시간차만 찾는다
    assert corr > 0.99
    matched = v.align(est, ref, 1.0, offset)
    assert v.stats(matched[0], matched[1])["bias"] == pytest.approx(8.0, abs=0.5)


def test_held_samples_are_excluded_but_counted() -> None:
    """보류한 값은 정확도 계산에서 빠지고, 보류율로 따로 보고된다 (README §0-4)."""
    est = v.load_estimate(DATA / "static_demo_r1.csv")
    assert 0.0 < est.held_ratio < 0.5
    assert np.isnan(est.bpm).sum() > 0
    matched, _, _ = _pairs(
        "static_demo_r1.csv", "static1_ref.csv", ref_warmup=20, demo_warmup=0, tol=2.0
    )
    assert not np.isnan(matched).any()


def test_reads_our_own_metrics_csv_format(tmp_path: Path) -> None:
    """긴 형식(logs/metrics.csv)도 같은 코드로 읽힌다."""
    path = tmp_path / "metrics.csv"
    path.write_text(
        "ts,device_id,key,value,unit,source,mode,state,confidence\n"
        "2026-01-01T00:00:00+00:00,d,hr,70.0,bpm,rppg,live,ok,0.90\n"
        "2026-01-01T00:00:01+00:00,d,hr,,bpm,rppg,live,low_quality,0.20\n"
        "2026-01-01T00:00:02+00:00,d,hr,72.0,bpm,rppg,live,ok,0.88\n"
        "2026-01-01T00:00:02+00:00,d,rr,15.0,rpm,rr,simulated,ok,0.80\n",
        encoding="utf-8",
    )
    series = v.load_estimate(path, key="hr")

    assert list(series.t) == [0.0, 1.0, 2.0]
    assert series.held_ratio == pytest.approx(1 / 3)
    assert series.confidence[0] == pytest.approx(0.90)
