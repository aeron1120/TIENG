"""펄스옥시미터 기준 정량 검증.

    python scripts/validate_vs_oximeter.py \
        --rppg logs/metrics.csv --ref logs/oximeter.csv --out reports/accuracy.md

발표에서 "정확하다"고 말하려면 숫자가 있어야 한다. MAE/RMSE 만 내는 게 아니라
**보류율과 게이팅 효과**를 같이 낸다. 못 믿을 구간을 걸러서 정확해진 것과 원래
정확한 것은 다르고, 이 프로젝트가 주장하는 건 전자다.

입력 형식 두 가지를 모두 받는다.
  - 우리 logs/metrics.csv  (ts,device_id,key,value,... 긴 형식)
  - legacy 데모 CSV        (elapsed_sec,heart_bpm,heart_sqi,... 넓은 형식)

기준 CSV 는 시간 열(elapsed_sec/time/sec/t)과 맥박 열(pr/bpm/hr/pulse)을 자동
인식한다. 못 찾으면 --ref-time-col / --ref-bpm-col 로 직접 지정.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import force_utf8  # noqa: E402

force_utf8()

TIME_COLS = ("elapsed_sec", "time", "sec", "t", "timestamp", "ts")
BPM_COLS = ("pr", "bpm", "hr", "pulse", "heart_bpm", "spo2_hr", "heart_rate")


@dataclass
class Series:
    t: np.ndarray  # 세션 시작 기준 경과 초
    bpm: np.ndarray  # 보류 구간은 nan
    confidence: np.ndarray  # 없으면 nan

    @property
    def held_ratio(self) -> float:
        return float(np.isnan(self.bpm).mean()) if len(self.bpm) else 0.0


# --------------------------------------------------------------------------- #
# 로딩


def _rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _pick(fields: list[str], candidates: tuple[str, ...], override: str | None) -> str:
    if override:
        if override not in fields:
            raise SystemExit(f"열 '{override}' 이 없다. 있는 열: {fields}")
        return override
    for name in candidates:
        if name in fields:
            return name
    raise SystemExit(f"시간/값 열을 못 찾았다. 있는 열: {fields}\n--ref-time-col 로 지정할 것")


def _to_float(text: str) -> float:
    text = (text or "").strip()
    if not text:
        return math.nan
    try:
        return float(text)
    except ValueError:
        return math.nan


def load_estimate(path: Path, key: str = "hr") -> Series:
    """우리 metrics.csv 또는 legacy 데모 CSV 를 읽는다."""
    rows = _rows(path)
    if not rows:
        raise SystemExit(f"{path} 가 비어 있다")
    fields = list(rows[0])

    if "key" in fields and "value" in fields:  # 우리 긴 형식
        rows = [r for r in rows if r["key"] == key]
        if not rows:
            raise SystemExit(f"{path} 에 key={key} 행이 없다")
        stamps = [datetime.fromisoformat(r["ts"]) for r in rows]
        base = stamps[0]
        return Series(
            t=np.array([(s - base).total_seconds() for s in stamps]),
            bpm=np.array([_to_float(r["value"]) for r in rows]),
            confidence=np.array([_to_float(r.get("confidence", "")) for r in rows]),
        )

    # legacy 넓은 형식
    time_col = _pick(fields, TIME_COLS, None)
    bpm_col = _pick(fields, BPM_COLS, None)
    conf_col = next((c for c in ("heart_sqi", "confidence", "sqi") if c in fields), None)
    return Series(
        t=np.array([_to_float(r[time_col]) for r in rows]),
        bpm=np.array([_to_float(r[bpm_col]) for r in rows]),
        confidence=np.array(
            [_to_float(r[conf_col]) for r in rows] if conf_col else [math.nan] * len(rows)
        ),
    )


def load_reference(path: Path, time_col: str | None, bpm_col: str | None) -> Series:
    rows = _rows(path)
    if not rows:
        raise SystemExit(f"{path} 가 비어 있다")
    fields = list(rows[0])
    tc = _pick(fields, TIME_COLS, time_col)
    bc = _pick(fields, BPM_COLS, bpm_col)
    t = np.array([_to_float(r[tc]) for r in rows])
    bpm = np.array([_to_float(r[bc]) for r in rows])
    ok = ~np.isnan(t) & ~np.isnan(bpm)
    return Series(t=t[ok], bpm=bpm[ok], confidence=np.full(int(ok.sum()), math.nan))


# --------------------------------------------------------------------------- #
# 정렬과 통계


def _drop_warmup(s: Series, seconds: float) -> Series:
    if seconds <= 0 or len(s.t) == 0:
        return s
    keep = s.t >= (s.t.min() + seconds)
    return Series(t=s.t[keep], bpm=s.bpm[keep], confidence=s.confidence[keep])


def find_lag(est: Series, ref: Series, max_lag: float, step: float) -> tuple[float, float]:
    """두 기기의 시작시각 차이를 상호상관으로 찾는다.

    옥시미터와 이 시스템은 서로의 시계를 모른다. 몇 초만 어긋나도 상관계수가
    무너져 실제보다 나쁜 수치가 나온다.

    MAE 를 최소화하는 offset 을 찾으면 보고할 지표를 직접 깎는 셈이라 결과가
    오염된다. 상관계수는 두 신호의 평균 차이(bias)에 영향받지 않으므로 그쪽을
    최대화한다 (legacy VALIDATION_PROTOCOL §3-2 와 같은 방법).
    """
    valid = ~np.isnan(est.bpm)
    if valid.sum() < 10 or len(ref.t) < 2:
        return 0.0, math.nan

    lo = max(float(est.t[valid].min()), float(ref.t.min()))
    hi = min(float(est.t[valid].max()), float(ref.t.max()))
    if hi - lo < 5.0:
        return 0.0, math.nan

    grid = np.arange(lo, hi, 1.0)  # 1Hz 공통 격자
    ref_grid = np.interp(grid, ref.t, ref.bpm, left=np.nan, right=np.nan)

    best_tau, best_corr = 0.0, -2.0
    for tau in np.arange(-max_lag, max_lag + 1e-9, step):
        shifted = np.interp(
            grid, est.t[valid] + tau, est.bpm[valid], left=np.nan, right=np.nan
        )
        both = np.isfinite(shifted) & np.isfinite(ref_grid)
        if both.sum() < 10:
            continue
        a, b = shifted[both], ref_grid[both]
        if np.std(a) < 1e-9 or np.std(b) < 1e-9:
            continue
        corr = float(np.corrcoef(a, b)[0, 1])
        if corr > best_corr:
            best_tau, best_corr = float(tau), corr
    return best_tau, (best_corr if best_corr > -2.0 else math.nan)


def align(est: Series, ref: Series, tolerance: float, offset: float) -> tuple[np.ndarray, ...]:
    """추정 시각마다 tolerance 이내의 가장 가까운 기준값을 붙인다.

    기준값을 보간하지 않는 이유: 2초 간격으로 잰 맥박 사이가 어떻게 움직였는지
    모른다. 없는 기준을 만들어 내면 그만큼 검증이 허술해진다.

    보류(nan)된 추정치는 애초에 짝에서 빠지고, 그 사실은 보류율이 따로 말한다.
    """
    empty = (np.array([]), np.array([]), np.array([]))
    valid = ~np.isnan(est.bpm)
    if not valid.any() or len(ref.t) == 0:
        return empty

    et = est.t[valid] + offset
    eb, ec = est.bpm[valid], est.confidence[valid]

    gaps = np.abs(et[:, None] - ref.t[None, :])
    nearest = np.argmin(gaps, axis=1)
    near = gaps[np.arange(len(et)), nearest] <= tolerance
    return eb[near], ref.bpm[nearest][near], ec[near]


def stats(est: np.ndarray, ref: np.ndarray) -> dict[str, float]:
    n = len(est)
    if n == 0:
        return {"n": 0}
    diff = est - ref
    out = {
        "n": n,
        "bias": float(np.mean(diff)),
        "mae": float(np.mean(np.abs(diff))),
        "rmse": float(np.sqrt(np.mean(diff**2))),
        "within5": float(np.mean(np.abs(diff) <= 5) * 100),
        "within10": float(np.mean(np.abs(diff) <= 10) * 100),
        # Bland-Altman 일치 한계. 평균오차만 보면 큰 편차가 숨는다.
        "loa_lo": float(np.mean(diff) - 1.96 * np.std(diff)),
        "loa_hi": float(np.mean(diff) + 1.96 * np.std(diff)),
    }
    out["pearson"] = (
        float(np.corrcoef(est, ref)[0, 1]) if n >= 2 and np.std(est) > 0 and np.std(ref) > 0
        else math.nan
    )
    return out


def _row(label: str, s: dict[str, float]) -> str:
    if s["n"] == 0:
        return f"| {label} | 0 | — | — | — | — | — | — | — |"
    return (
        f"| {label} | {s['n']} | {s['bias']:+.2f} | {s['mae']:.2f} | {s['rmse']:.2f} | "
        f"{s['within5']:.1f}% | {s['within10']:.1f}% | {s['pearson']:.3f} | "
        f"{s['loa_lo']:.2f} ~ {s['loa_hi']:+.2f} |"
    )


# --------------------------------------------------------------------------- #


def main() -> int:
    p = argparse.ArgumentParser(description="펄스옥시미터 기준 rPPG 정확도 검증")
    p.add_argument("--rppg", required=True, type=Path, help="metrics.csv 또는 legacy 데모 CSV")
    p.add_argument("--ref", required=True, type=Path, help="옥시미터 기준 CSV")
    p.add_argument("--out", type=Path, help="마크다운 리포트 저장 경로")
    p.add_argument("--key", default="hr", help="긴 형식에서 볼 metric key")
    p.add_argument("--gate", type=float, default=0.5, help="게이팅 효과를 볼 confidence 기준")
    p.add_argument("--tolerance", type=float, default=2.0, help="짝짓기 허용 시간차(초)")
    p.add_argument("--offset", type=float, help="시작시각 보정(초). 생략하면 자동 탐색")
    p.add_argument("--max-lag", type=float, default=5.0, help="자동 탐색 범위(초)")
    p.add_argument("--lag-step", type=float, default=0.5)
    # 옥시미터는 손가락에 끼운 뒤 값이 안정되기까지 시간이 걸린다. 그 구간을
    # 기준으로 쓰면 카메라가 틀린 것처럼 보인다 (legacy MEASUREMENT_SESSION_GUIDE).
    p.add_argument("--ref-warmup-sec", type=float, default=0.0, help="기준 초반 제외(초)")
    p.add_argument("--demo-warmup-sec", type=float, default=0.0, help="추정 초반 제외(초)")
    p.add_argument("--ref-time-col")
    p.add_argument("--ref-bpm-col")
    args = p.parse_args()

    est = load_estimate(args.rppg, args.key)
    ref = load_reference(args.ref, args.ref_time_col, args.ref_bpm_col)
    est = _drop_warmup(est, args.demo_warmup_sec)
    ref = _drop_warmup(ref, args.ref_warmup_sec)

    if args.offset is None:
        offset, corr = find_lag(est, ref, args.max_lag, args.lag_step)
        how = f"자동 탐색 {offset:+.1f}s (상관 {corr:.3f})" if math.isfinite(corr) else "탐색 실패"
    else:
        offset, how = args.offset, f"수동 지정 {args.offset:+.1f}s"

    e, r, c = align(est, ref, args.tolerance, offset)

    lines = [
        "# rPPG 정확도 검증",
        "",
        f"- 추정: `{args.rppg}` ({len(est.bpm)} 샘플)",
        f"- 기준: `{args.ref}` ({len(ref.bpm)} 샘플)",
        f"- 짝짓기 허용 {args.tolerance}s, 시작시각 보정 {how}",
        "",
        "```",
        # 아카이브된 legacy 리포트는 실행 인자를 안 남겨 재현이 안 됐다.
        # 같은 실수를 반복하지 않으려고 명령을 리포트에 박아 둔다.
        " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]),
        "```",
        "",
        "## 보류율",
        "",
        f"전체 {len(est.bpm)} 샘플 중 **{est.held_ratio * 100:.1f}%** 를 품질 미달로 보류했다.",
        "보류한 구간에는 값을 내지 않았으므로 아래 정확도는 '내보낸 값'에 대한 것이다.",
        "",
        "## 정확도",
        "",
        "| 구간 | n | bias | MAE | RMSE | ±5bpm | ±10bpm | r | LoA(95%) |",
        "|---|---|---|---|---|---|---|---|---|",
        _row("내보낸 값 전체", stats(e, r)),
    ]

    if len(c) and not np.all(np.isnan(c)):
        hi, lo = c >= args.gate, c < args.gate
        lines += [
            _row(f"confidence ≥ {args.gate}", stats(e[hi], r[hi])),
            _row(f"confidence < {args.gate}", stats(e[lo], r[lo])),
        ]

    s = stats(e, r)
    lines += ["", "## 읽는 법", ""]
    if s["n"] == 0:
        lines.append("짝지어진 표본이 없다. `--offset` 으로 시작시각을 맞추거나 "
                     "`--tolerance` 를 늘려 볼 것.")
    else:
        lines += [
            f"- **MAE {s['mae']:.2f} bpm** — 평균적으로 이만큼 틀린다.",
            f"- **±5bpm 이내 {s['within5']:.1f}%** — 임상 참고 기준으로 흔히 쓰이는 구간.",
            f"- **LoA {s['loa_lo']:.1f} ~ {s['loa_hi']:+.1f} bpm** — 개별 측정의 95% 가 "
            "이 범위에 든다. 평균만 보면 숨는 편차다.",
            "",
            "> 연구·교육·시연용 수치다. 의료 진단 근거로 쓸 수 없다.",
        ]

    text = "\n".join(lines) + "\n"
    print(text)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"저장: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
