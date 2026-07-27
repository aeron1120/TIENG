"""
evaluate.py  -  TIENG rPPG 정량 검증 하네스
============================================
rppg_demo_v4.py 가 남긴 측정 CSV(--demo)와 펄스옥시미터/ECG 기준 CSV(--ref)를
시간축으로 정렬해 다음을 산출한다.

    - bias, MAE, RMSE, 상관계수 r
    - ±5 BPM / ±10 BPM 이내 일치율
    - 측정 보류율(hold rate), SQI >= gate coverage
    - SQI 게이트 '전(all)' vs '통과(>=gate)' vs '미달(<gate)' 대비
      (논문 5.2.2의 "저품질 제거 시 MAE 30.7 -> 2.89 bpm" 재현용)
    - 시나리오(static/lighting/head_motion)별 표 (demo CSV에 scenario 열이 있으면)

출력: 콘솔 표 + summary.csv + (matplotlib 있으면) timeline/scatter/bland_altman PNG

의존성: numpy (필수), matplotlib (선택, 플롯용)

실행 예:
    python evaluate.py --demo measurements.csv --ref pulseox.csv --out report/
    python evaluate.py --demo measurements.csv --ref pulseox.csv --offset -1.5 --sqi-gate 0.5
    python evaluate.py --demo measurements.csv --ref pulseox.csv --auto-offset  # 상호상관 자동 미세정렬
    python evaluate.py --selftest        # 합성 데이터로 지표 계산 검증

주의: 웰니스 데모 검증용이며 의료적 정확도 주장 근거로 쓰지 않는다.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# 기준 CSV의 열 이름 자동 탐지 후보 (소문자 비교)
REF_TIME_CANDIDATES = ["elapsed_sec", "time", "timestamp", "sec", "seconds", "t", "rel_time"]
REF_BPM_CANDIDATES = ["bpm", "hr", "heart_rate", "heartrate", "pulse", "pr", "spo2_hr", "hr_ref"]


# --------------------------------------------------------------------------- #
# CSV 로딩
# --------------------------------------------------------------------------- #
def load_csv(path: str) -> Tuple[List[str], List[Dict[str, str]]]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"CSV를 찾을 수 없습니다: {path}")
    with p.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        header = reader.fieldnames or []
    if not rows:
        raise ValueError(f"CSV가 비어 있습니다: {path}")
    return list(header), rows


def _to_float(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    value = value.strip()
    if value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def autodetect_column(header: Sequence[str], candidates: Sequence[str], role: str) -> str:
    lower = {h.lower(): h for h in header}
    for cand in candidates:
        if cand in lower:
            return lower[cand]
    raise ValueError(
        f"{role} 열을 자동 인식하지 못했습니다. 헤더={list(header)} / 후보={list(candidates)}\n"
        f"--ref-{role}-col 로 직접 지정하세요."
    )


# --------------------------------------------------------------------------- #
# 시간 정렬 (as-of nearest)
# --------------------------------------------------------------------------- #
def align_nearest(
    demo_t: np.ndarray,
    ref_t: np.ndarray,
    ref_v: np.ndarray,
    tolerance: float,
) -> np.ndarray:
    """
    demo_t 각 시점에 대해 |demo_t - ref_t| 가 tolerance 이내인 가장 가까운 ref 값을 반환.
    매칭 실패 시 np.nan. ref_t는 정렬되어 있다고 가정(아니면 내부 정렬).
    """
    order = np.argsort(ref_t)
    rt = ref_t[order]
    rv = ref_v[order]
    idx = np.searchsorted(rt, demo_t)
    out = np.full(demo_t.shape, np.nan)
    for i, (t, k) in enumerate(zip(demo_t, idx)):
        best_dt = math.inf
        best_val = np.nan
        for j in (k - 1, k):
            if 0 <= j < len(rt):
                dt = abs(t - rt[j])
                if dt < best_dt:
                    best_dt = dt
                    best_val = rv[j]
        if best_dt <= tolerance:
            out[i] = best_val
    return out


def resample_to_grid(t: np.ndarray, v: np.ndarray, grid: np.ndarray) -> np.ndarray:
    """(t, v)를 공통 시간 격자(grid)로 선형보간. 격자 범위 밖은 nan."""
    mask = np.isfinite(t) & np.isfinite(v)
    if mask.sum() < 2:
        return np.full(grid.shape, np.nan)
    order = np.argsort(t[mask])
    return np.interp(grid, t[mask][order], v[mask][order], left=np.nan, right=np.nan)


def lag_search(
    demo_t: np.ndarray,
    demo_bpm: np.ndarray,
    ref_t: np.ndarray,
    ref_v: np.ndarray,
    max_lag: float,
    step: float,
) -> Tuple[float, float, int]:
    """
    1Hz 공통 격자에서 상호상관을 최대화하는 잔차 지연 tau를 탐색(VALIDATION_PROTOCOL §3-2).
    상관계수는 두 신호의 평균 차이(bias)에 영향받지 않으므로, MAE를 직접 최소화하는
    offset 탐색과 달리 보고 지표를 오염시키지 않는다. 매칭 없으면 (0.0, nan, 0) 반환.
    """
    t_lo = max(float(np.nanmin(demo_t)), float(np.nanmin(ref_t)))
    t_hi = min(float(np.nanmax(demo_t)), float(np.nanmax(ref_t)))
    if not math.isfinite(t_lo) or not math.isfinite(t_hi) or t_hi - t_lo < 5.0:
        return 0.0, math.nan, 0
    grid = np.arange(t_lo, t_hi, 1.0)
    ref_grid = resample_to_grid(ref_t, ref_v, grid)

    best_tau, best_corr, best_n = 0.0, -2.0, 0
    for tau in np.arange(-max_lag, max_lag + 1e-9, step):
        demo_grid = resample_to_grid(demo_t + tau, demo_bpm, grid)
        mask = np.isfinite(demo_grid) & np.isfinite(ref_grid)
        n = int(mask.sum())
        if n < 10:
            continue
        a, b = demo_grid[mask], ref_grid[mask]
        if np.std(a) < 1e-9 or np.std(b) < 1e-9:
            continue
        c = float(np.corrcoef(a, b)[0, 1])
        if c > best_corr:
            best_tau, best_corr, best_n = float(tau), c, n
    return best_tau, best_corr, best_n


# --------------------------------------------------------------------------- #
# 지표
# --------------------------------------------------------------------------- #
@dataclass
class Metrics:
    label: str
    n: int
    bias: float
    mae: float
    rmse: float
    within5_pct: float
    within10_pct: float
    corr: float
    sd: float
    loa_lower: float
    loa_upper: float

    def as_row(self) -> Dict[str, str]:
        return {
            "subset": self.label,
            "n": str(self.n),
            "bias_bpm": f"{self.bias:.2f}",
            "mae_bpm": f"{self.mae:.2f}",
            "rmse_bpm": f"{self.rmse:.2f}",
            "within_5bpm_pct": f"{self.within5_pct:.1f}",
            "within_10bpm_pct": f"{self.within10_pct:.1f}",
            "pearson_r": f"{self.corr:.3f}",
            "loa_lower_bpm": f"{self.loa_lower:.2f}",
            "loa_upper_bpm": f"{self.loa_upper:.2f}",
        }


def compute_metrics(label: str, est: np.ndarray, ref: np.ndarray) -> Metrics:
    mask = np.isfinite(est) & np.isfinite(ref)
    est = est[mask]
    ref = ref[mask]
    n = int(len(est))
    if n == 0:
        return Metrics(label, 0, math.nan, math.nan, math.nan, 0.0, 0.0, math.nan, math.nan, math.nan, math.nan)
    diff = est - ref
    bias = float(np.mean(diff))
    sd = float(np.std(diff))
    mae = float(np.mean(np.abs(diff)))
    rmse = float(np.sqrt(np.mean(diff ** 2)))
    within5 = float(np.mean(np.abs(diff) <= 5.0) * 100.0)
    within10 = float(np.mean(np.abs(diff) <= 10.0) * 100.0)
    if n >= 2 and np.std(est) > 1e-9 and np.std(ref) > 1e-9:
        corr = float(np.corrcoef(est, ref)[0, 1])
    else:
        corr = math.nan
    loa_lower = bias - 1.96 * sd
    loa_upper = bias + 1.96 * sd
    return Metrics(label, n, bias, mae, rmse, within5, within10, corr, sd, loa_lower, loa_upper)


@dataclass
class Coverage:
    total_update_rows: int
    valid_bpm_rows: int
    sqi_pass_rows: int
    hold_rows: int

    @property
    def hold_rate_pct(self) -> float:
        return 100.0 * self.hold_rows / self.total_update_rows if self.total_update_rows else 0.0

    @property
    def sqi_coverage_pct(self) -> float:
        return 100.0 * self.sqi_pass_rows / self.total_update_rows if self.total_update_rows else 0.0


# --------------------------------------------------------------------------- #
# 핵심 평가
# --------------------------------------------------------------------------- #
@dataclass
class DemoSeries:
    t: np.ndarray
    bpm: np.ndarray          # nan 가능
    sqi: np.ndarray
    status: np.ndarray       # object array of str
    scenario: np.ndarray     # object array of str ("" 가능)


def parse_demo(rows: List[Dict[str, str]]) -> DemoSeries:
    def col(row, *names):
        for nm in names:
            if nm in row:
                return row[nm]
        return None

    t, bpm, sqi, status, scen = [], [], [], [], []
    for r in rows:
        tv = _to_float(col(r, "elapsed_sec", "time", "t"))
        if tv is None:
            continue
        t.append(tv)
        bpm.append(_to_float(col(r, "heart_bpm", "bpm")) or np.nan)
        sqi.append(_to_float(col(r, "heart_sqi", "sqi")) or 0.0)
        status.append((col(r, "heart_status") or "").strip())
        scen.append((col(r, "scenario") or "").strip())
    return DemoSeries(
        np.asarray(t, float),
        np.asarray(bpm, float),
        np.asarray(sqi, float),
        np.asarray(status, dtype=object),
        np.asarray(scen, dtype=object),
    )


def coverage_of(demo: DemoSeries, gate: float) -> Coverage:
    total = len(demo.t)
    valid = int(np.sum(np.isfinite(demo.bpm)))
    sqi_pass = int(np.sum(demo.sqi >= gate))
    hold = int(np.sum(~np.isfinite(demo.bpm) | (demo.sqi < gate)))
    return Coverage(total, valid, sqi_pass, hold)


def evaluate_subset(
    demo: DemoSeries,
    ref_at_demo: np.ndarray,
    gate: float,
    prefix: str = "",
) -> List[Metrics]:
    est = demo.bpm.copy()
    sqi = demo.sqi
    pfx = f"{prefix} " if prefix else ""
    all_m = compute_metrics(f"{pfx}all(valid bpm)", est, ref_at_demo)
    pass_est = np.where(sqi >= gate, est, np.nan)
    fail_est = np.where(sqi < gate, est, np.nan)
    pass_m = compute_metrics(f"{pfx}SQI>={gate:.2f}", pass_est, ref_at_demo)
    fail_m = compute_metrics(f"{pfx}SQI<{gate:.2f}", fail_est, ref_at_demo)
    return [all_m, pass_m, fail_m]


def print_table(metrics: List[Metrics], coverage: Optional[Coverage], gate: float) -> None:
    cols = ["subset", "n", "bias", "MAE", "RMSE", "±5%", "±10%", "r"]
    widths = [26, 5, 7, 7, 7, 7, 7, 7]
    line = "".join(c.ljust(w) for c, w in zip(cols, widths))
    print(line)
    print("-" * len(line))
    for m in metrics:
        vals = [
            m.label, str(m.n), f"{m.bias:.2f}", f"{m.mae:.2f}", f"{m.rmse:.2f}",
            f"{m.within5_pct:.1f}", f"{m.within10_pct:.1f}",
            "nan" if math.isnan(m.corr) else f"{m.corr:.2f}",
        ]
        print("".join(str(v).ljust(w) for v, w in zip(vals, widths)))
    if coverage is not None:
        print("-" * len(line))
        print(
            f"coverage: update_rows={coverage.total_update_rows}  "
            f"valid_bpm={coverage.valid_bpm_rows}  "
            f"SQI>={gate:.2f} coverage={coverage.sqi_coverage_pct:.1f}%  "
            f"hold_rate={coverage.hold_rate_pct:.1f}%"
        )


# --------------------------------------------------------------------------- #
# 플롯 (matplotlib 선택)
# --------------------------------------------------------------------------- #
def make_plots(demo: DemoSeries, ref_at_demo: np.ndarray, gate: float, out_dir: Path) -> List[str]:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        print("[info] matplotlib 미설치 - 플롯 생략 (pip install matplotlib)")
        return []

    saved = []
    est = demo.bpm
    ok = np.isfinite(est) & np.isfinite(ref_at_demo)
    passm = ok & (demo.sqi >= gate)

    # 1) timeline
    fig, ax = plt.subplots(figsize=(9, 4))
    ax.plot(demo.t, ref_at_demo, label="reference (pulse-ox)", color="black", lw=1.5)
    ax.plot(demo.t, np.where(np.isfinite(est), est, np.nan), label="rPPG demo", color="tab:red", lw=1, alpha=0.7)
    ax.scatter(demo.t[passm], est[passm], s=12, color="tab:green", label=f"SQI>={gate:.2f}", zorder=5)
    ax.set_xlabel("elapsed (s)"); ax.set_ylabel("HR (BPM)"); ax.legend(); ax.set_title("HR timeline")
    fig.tight_layout(); f1 = out_dir / "timeline.png"; fig.savefig(f1, dpi=110); plt.close(fig); saved.append(str(f1))

    # 2) scatter
    fig, ax = plt.subplots(figsize=(5, 5))
    ax.scatter(ref_at_demo[ok], est[ok], s=14, alpha=0.4, color="tab:gray", label="all")
    ax.scatter(ref_at_demo[passm], est[passm], s=16, color="tab:green", label=f"SQI>={gate:.2f}")
    lo = float(np.nanmin([np.nanmin(ref_at_demo[ok]), np.nanmin(est[ok])])) - 5 if ok.any() else 40
    hi = float(np.nanmax([np.nanmax(ref_at_demo[ok]), np.nanmax(est[ok])])) + 5 if ok.any() else 180
    ax.plot([lo, hi], [lo, hi], "k--", lw=1)
    ax.set_xlabel("reference HR"); ax.set_ylabel("rPPG HR"); ax.legend(); ax.set_title("Scatter (equality line)")
    fig.tight_layout(); f2 = out_dir / "scatter.png"; fig.savefig(f2, dpi=110); plt.close(fig); saved.append(str(f2))

    # 3) Bland-Altman (SQI 통과분)
    if passm.sum() >= 2:
        mean = (est[passm] + ref_at_demo[passm]) / 2.0
        diff = est[passm] - ref_at_demo[passm]
        bias = float(np.mean(diff)); sd = float(np.std(diff))
        fig, ax = plt.subplots(figsize=(6, 4))
        ax.scatter(mean, diff, s=16, color="tab:green")
        ax.axhline(bias, color="tab:blue", label=f"bias={bias:.2f}")
        ax.axhline(bias + 1.96 * sd, color="tab:red", ls="--", label=f"+1.96SD={bias+1.96*sd:.1f}")
        ax.axhline(bias - 1.96 * sd, color="tab:red", ls="--", label=f"-1.96SD={bias-1.96*sd:.1f}")
        ax.set_xlabel("mean of demo & ref"); ax.set_ylabel("demo - ref"); ax.legend()
        ax.set_title(f"Bland-Altman (SQI>={gate:.2f})")
        fig.tight_layout(); f3 = out_dir / "bland_altman.png"; fig.savefig(f3, dpi=110); plt.close(fig); saved.append(str(f3))
    return saved


# --------------------------------------------------------------------------- #
# 메인
# --------------------------------------------------------------------------- #
def run(args: argparse.Namespace) -> int:
    _, demo_rows = load_csv(args.demo)
    demo = parse_demo(demo_rows)
    if args.demo_warmup_sec > 0:
        keep = demo.t >= args.demo_warmup_sec
        print(f"[info] demo-warmup-sec={args.demo_warmup_sec:.1f}s: dropping {int((~keep).sum())}/{len(demo.t)} "
              f"early demo rows (알고리즘 시동 구간의 하모닉 배가 오류 등 배제)")
        demo = DemoSeries(demo.t[keep], demo.bpm[keep], demo.sqi[keep], demo.status[keep], demo.scenario[keep])
    demo = DemoSeries(demo.t + args.offset, demo.bpm, demo.sqi, demo.status, demo.scenario)

    ref_header, ref_rows = load_csv(args.ref)
    ref_time_col = args.ref_time_col or autodetect_column(ref_header, REF_TIME_CANDIDATES, "time")
    ref_bpm_col = args.ref_bpm_col or autodetect_column(ref_header, REF_BPM_CANDIDATES, "bpm")
    ref_t = np.array([_to_float(r[ref_time_col]) for r in ref_rows], dtype=float)
    ref_v = np.array([_to_float(r[ref_bpm_col]) for r in ref_rows], dtype=float)
    good = np.isfinite(ref_t) & np.isfinite(ref_v)
    ref_t, ref_v = ref_t[good], ref_v[good]
    if args.ref_warmup_sec > 0:
        keep = ref_t >= args.ref_warmup_sec
        print(f"[info] ref-warmup-sec={args.ref_warmup_sec:.1f}s: dropping {int((~keep).sum())}/{len(ref_t)} "
              f"early ref samples (오심미터 착용 직후 불안정 구간 제외)")
        ref_t, ref_v = ref_t[keep], ref_v[keep]
    print(f"[info] ref time col='{ref_time_col}', bpm col='{ref_bpm_col}', ref samples={len(ref_t)}")

    if args.auto_offset:
        tau, corr_val, n_ov = lag_search(demo.t, demo.bpm, ref_t, ref_v, args.max_lag, args.lag_step)
        print(f"[info] auto lag-search: tau={tau:+.2f}s (corr={corr_val:.3f}, overlap n={n_ov}) "
              f"applied on top of --offset={args.offset:+.2f}s")
        demo = DemoSeries(demo.t + tau, demo.bpm, demo.sqi, demo.status, demo.scenario)

    ref_at_demo = align_nearest(demo.t, ref_t, ref_v, args.tolerance)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("\n================ OVERALL ================")
    metrics = evaluate_subset(demo, ref_at_demo, args.sqi_gate)
    cov = coverage_of(demo, args.sqi_gate)
    print_table(metrics, cov, args.sqi_gate)

    all_metric_rows = [m.as_row() for m in metrics]

    # 시나리오별
    scenarios = sorted({s for s in demo.scenario.tolist() if s})
    for sc in scenarios:
        sel = demo.scenario == sc
        sub = DemoSeries(demo.t[sel], demo.bpm[sel], demo.sqi[sel], demo.status[sel], demo.scenario[sel])
        sub_ref = ref_at_demo[sel]
        print(f"\n================ SCENARIO: {sc} ================")
        sm = evaluate_subset(sub, sub_ref, args.sqi_gate, prefix=sc)
        print_table(sm, coverage_of(sub, args.sqi_gate), args.sqi_gate)
        all_metric_rows.extend(m.as_row() for m in sm)

    # summary.csv
    summ = out_dir / "summary.csv"
    with summ.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(all_metric_rows[0].keys()))
        w.writeheader(); w.writerows(all_metric_rows)
    print(f"\n[saved] {summ}")

    if not args.no_plots:
        for p in make_plots(demo, ref_at_demo, args.sqi_gate, out_dir):
            print(f"[saved] {p}")
    return 0


# --------------------------------------------------------------------------- #
# Selftest
# --------------------------------------------------------------------------- #
def selftest() -> bool:
    print("=== evaluate.py SELFTEST ===")
    rng = np.random.default_rng(1)
    t = np.arange(0, 60, 0.5)
    ref_bpm = 72 + 3 * np.sin(2 * np.pi * 0.02 * t)

    # 고품질 구간: 오차 작음 / 저품질 구간(뒤쪽 20s): 큰 음의 편차 (논문 패턴 모사)
    est = ref_bpm + rng.normal(0, 1.0, size=t.shape)
    sqi = np.full_like(t, 0.8)
    lowq = t >= 40
    est[lowq] = ref_bpm[lowq] - 25 + rng.normal(0, 2, size=int(lowq.sum()))
    sqi[lowq] = 0.3

    demo = DemoSeries(t, est, sqi, np.array(["ok"] * len(t), dtype=object),
                      np.array([""] * len(t), dtype=object))
    ref_at = align_nearest(t, t, ref_bpm, 0.1)  # 완전 정렬

    ms = evaluate_subset(demo, ref_at, 0.5)
    by = {m.label.split()[-1] if " " in m.label else m.label: m for m in ms}
    all_m, pass_m, fail_m = ms[0], ms[1], ms[2]

    c1 = pass_m.mae < 3.0                      # 고품질 MAE 작아야
    c2 = fail_m.mae > 15.0                     # 저품질 MAE 커야
    c3 = all_m.mae > pass_m.mae                # 게이팅이 MAE 개선
    c4 = 79.0 <= pass_m.within5_pct <= 100.0   # 고품질 ±5 대부분 통과

    # coverage 검증
    cov = coverage_of(demo, 0.5)
    c5 = cov.total_update_rows == len(t)
    c6 = abs(cov.sqi_coverage_pct - 100.0 * (sqi >= 0.5).mean()) < 1e-6

    # align 검증: tolerance 벗어나면 nan
    off = align_nearest(np.array([100.0]), t, ref_bpm, 2.0)
    c7 = np.isnan(off[0])

    for name, ok in [("pass MAE<3", c1), ("fail MAE>15", c2), ("gating improves MAE", c3),
                     ("pass ±5>=79%", c4), ("coverage rows", c5), ("sqi coverage", c6),
                     ("align tol nan", c7)]:
        print(f"  {'OK' if ok else 'XX'} {name}")
    print(f"  detail: all MAE={all_m.mae:.2f}, pass MAE={pass_m.mae:.2f}, fail MAE={fail_m.mae:.2f}, "
          f"pass ±5={pass_m.within5_pct:.1f}%")
    ok = all([c1, c2, c3, c4, c5, c6, c7])
    print(f"=== RESULT: {'PASS' if ok else 'FAIL'} ===")
    return ok


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TIENG rPPG 정량 검증 하네스")
    p.add_argument("--demo", type=str, help="rppg_demo_v4.py --log 로 만든 측정 CSV")
    p.add_argument("--ref", type=str, help="펄스옥시미터/ECG 기준 CSV")
    p.add_argument("--out", type=str, default="report", help="결과 출력 폴더")
    p.add_argument("--sqi-gate", type=float, default=0.5, help="SQI 게이트 임계값")
    p.add_argument("--offset", type=float, default=0.0, help="demo 시간축에 더할 오프셋(초), 정렬 보정")
    p.add_argument("--tolerance", type=float, default=2.0, help="as-of 매칭 허용 시간차(초)")
    p.add_argument("--auto-offset", action="store_true",
                   help="1Hz 상호상관으로 잔차 offset 자동 탐색(--offset 적용 후 미세보정, VALIDATION_PROTOCOL §3-2)")
    p.add_argument("--max-lag", type=float, default=5.0, help="--auto-offset 탐색 범위(±초)")
    p.add_argument("--lag-step", type=float, default=0.1, help="--auto-offset 탐색 step(초)")
    p.add_argument("--ref-warmup-sec", type=float, default=0.0,
                   help="ref CSV에서 이 시각(초) 이전 샘플 제외 — 오심미터 착용 직후 불안정 구간 배제용")
    p.add_argument("--demo-warmup-sec", type=float, default=0.0,
                   help="demo CSV에서 이 시각(초, offset 적용 전 원 시계) 이전 행 제외 — rPPG 알고리즘 시동 구간(하모닉 배가 등) 배제용")
    p.add_argument("--ref-time-col", type=str, default="", help="기준 CSV 시간 열 이름(자동탐지 실패 시)")
    p.add_argument("--ref-bpm-col", type=str, default="", help="기준 CSV BPM 열 이름(자동탐지 실패 시)")
    p.add_argument("--no-plots", action="store_true", help="PNG 플롯 생략")
    p.add_argument("--selftest", action="store_true", help="합성 데이터로 지표 계산 검증")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if args.selftest:
        return 0 if selftest() else 1
    if not args.demo or not args.ref:
        print("사용법: python evaluate.py --demo measurements.csv --ref pulseox.csv [--out report/]")
        print("      : python evaluate.py --selftest")
        return 2
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
