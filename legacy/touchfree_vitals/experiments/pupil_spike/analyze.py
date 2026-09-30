"""PLR 실험 CSV → 게이트 판정.

"되네/안 되네" 대신 숫자를 낸다. 특히 게이트 4(분해능)가 이 실험의 목적이다 —
대광반사는 동공이 내는 가장 큰 신호라, 그 진폭이 잡음의 몇 배인지가 각성·스트레스
같은 작은 신호를 볼 예산이 있는지를 그대로 말해 준다.

    python analyze.py                  # out/ 의 가장 최근 CSV
    python analyze.py plr_2026...csv
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"

# 게이트 기준. 근거는 README 참고.
MIN_FACE_RATE = 0.95
MIN_PUPIL_RATE = 0.90
MAX_IRIS_CV = 0.03
MIN_DPRIME = 1.5
MIN_SNR = 3.0
# 대광반사는 신경 반사라 잠복기가 있다. 자극과 동시에 값이 변하면 그건 반사가
# 아니라 밝기가 바뀌면서 임계값이 밀린 것이다 — 이 실험에서 가장 속기 쉬운 함정.
MIN_LATENCY_S = 0.10

BASE_FROM, BASE_TO = -2.0, -0.2
RESP_TO = 4.0
GRID_HZ = 20.0


def load(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def num(row: dict, key: str) -> float:
    v = row.get(key, "")
    return float(v) if v not in ("", None) else float("nan")


def verdict(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


def analyze_eye(rows: list[dict], eye: str) -> dict:
    r = [x for x in rows if x["eye"] == eye]
    if not r:
        return {}

    t = np.array([num(x, "t_s") for x in r])
    face = np.array([x["face_ok"] == "1" for x in r])
    blink = np.array([x.get("blink") == "1" for x in r])
    pup = np.array([x["pupil_ok"] == "1" for x in r])
    ratio = np.array([num(x, "ratio") for x in r])
    dpr = np.array([num(x, "dprime") for x in r])
    iris_r = np.array([num(x, "iris_r_src_px") for x in r])
    stim = np.array([num(x, "stim_level") for x in r])
    fmean = np.array([num(x, "frame_mean") for x in r])

    usable = face & ~blink
    valid = usable & pup & np.isfinite(ratio)

    face_rate = float(face.mean())
    pupil_rate = float(pup[usable].mean()) if usable.any() else 0.0
    ir = iris_r[face & np.isfinite(iris_r)]
    iris_cv = float(ir.std() / ir.mean()) if ir.size > 2 and ir.mean() > 0 else float("nan")
    med_dp = float(np.nanmedian(dpr[valid])) if valid.any() else float("nan")
    med_ir = float(np.median(ir)) if ir.size else float("nan")

    plr = plr_response(t, ratio, valid, stim)
    return {
        "eye": eye, "n": len(r),
        "face_rate": face_rate, "pupil_rate": pupil_rate,
        "iris_cv": iris_cv, "median_iris_r": med_ir, "median_dprime": med_dp,
        "ae_corr": _corr(stim, fmean),
        **plr,
    }


def _corr(a: np.ndarray, b: np.ndarray) -> float:
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < 3 or a[m].std() < 1e-9 or b[m].std() < 1e-9:
        return float("nan")
    return float(np.corrcoef(a[m], b[m])[0, 1])


def plr_response(t: np.ndarray, ratio: np.ndarray, valid: np.ndarray,
                 stim: np.ndarray) -> dict:
    """밝기 상승 시점들을 겹쳐 평균 PLR 곡선을 만든다."""
    onsets = t[1:][(stim[1:] > 0.5) & (stim[:-1] <= 0.5)]
    empty = {"n_onsets": 0, "amplitude": float("nan"), "baseline_sd": float("nan"),
             "snr": float("nan"), "latency_s": float("nan"), "direction_ok": False,
             "curve_t": np.array([]), "curve": np.array([])}
    if onsets.size == 0 or valid.sum() < 20:
        return empty

    tv, rv = t[valid], ratio[valid]
    grid = np.arange(BASE_FROM, RESP_TO, 1.0 / GRID_HZ)
    stack = []
    for o in onsets:
        seg = (tv >= o + BASE_FROM) & (tv <= o + RESP_TO)
        if seg.sum() < 10:
            continue
        stack.append(np.interp(grid, tv[seg] - o, rv[seg], left=np.nan, right=np.nan))
    if not stack:
        return empty

    curve = np.nanmean(np.vstack(stack), axis=0)
    bmask = (grid >= BASE_FROM) & (grid <= BASE_TO)
    baseline = float(np.nanmean(curve[bmask]))

    # 자극 전 구간의 프레임간 흔들림 = 잡음 바닥. 여러 사이클의 표준편차를 모은다.
    sds = [float(np.nanstd(s[bmask])) for s in stack if np.isfinite(s[bmask]).sum() > 5]
    baseline_sd = float(np.mean(sds)) if sds else float("nan")

    rmask = (grid >= 0) & (grid <= RESP_TO)
    nadir = float(np.nanmin(curve[rmask]))
    amplitude = baseline - nadir  # 밝히면 수축 → 양수여야 한다
    direction_ok = amplitude > 0

    latency = float("nan")
    if direction_ok and np.isfinite(amplitude) and amplitude > 0:
        target = baseline - 0.25 * amplitude
        after = grid[rmask]
        vals = curve[rmask]
        hit = np.where(np.isfinite(vals) & (vals <= target))[0]
        if hit.size:
            latency = float(after[hit[0]])

    snr = abs(amplitude) / baseline_sd if baseline_sd and baseline_sd > 1e-9 else float("nan")
    return {"n_onsets": int(len(stack)), "amplitude": amplitude, "baseline_sd": baseline_sd,
            "snr": snr, "latency_s": latency, "direction_ok": direction_ok,
            "curve_t": grid, "curve": curve}


def report(res: dict) -> bool:
    e = res["eye"]
    print(f"\n{'=' * 66}\n  눈 {e}   (표본 {res['n']} 프레임)\n{'=' * 66}")

    g1 = res["face_rate"] >= MIN_FACE_RATE and res["pupil_rate"] >= MIN_PUPIL_RATE
    print(f"[{verdict(g1)}] 게이트1 검출 안정성")
    print(f"        얼굴 검출률   {res['face_rate'] * 100:5.1f}%  (기준 {MIN_FACE_RATE * 100:.0f}%)")
    print(f"        동공 검출률   {res['pupil_rate'] * 100:5.1f}%  (기준 {MIN_PUPIL_RATE * 100:.0f}%, 깜빡임 제외)")

    g2 = np.isfinite(res["iris_cv"]) and res["iris_cv"] <= MAX_IRIS_CV
    print(f"[{verdict(g2)}] 게이트2 기하 안정성")
    print(f"        홍채 반지름   {res['median_iris_r']:.1f} px (원본 해상도 기준)")
    print(f"        변동계수 CV   {res['iris_cv'] * 100:5.2f}%  (기준 {MAX_IRIS_CV * 100:.0f}%)")
    print("        홍채는 크기가 변하지 않는다 — 여기 흔들림은 전부 검출 잡음이거나")
    print("        머리가 앞뒤로 움직인 것이다.")

    g3 = np.isfinite(res["median_dprime"]) and res["median_dprime"] >= MIN_DPRIME
    print(f"[{verdict(g3)}] 게이트3 동공-홍채 대비")
    print(f"        d' 중앙값     {res['median_dprime']:5.2f}  (기준 {MIN_DPRIME})")
    print("        가시광에서 짙은 갈색 홍채면 여기서 떨어진다. IR 조명이 필요하다는 뜻.")

    # 잠복기 판정을 먼저 끝낸다. 진폭과 SNR 이 아무리 좋아도 자극과 동시에 값이
    # 변했다면 그건 반사가 아니므로, PASS 를 찍어 놓고 나중에 무르면 안 된다.
    lat = res["latency_s"]
    artifact = bool(np.isfinite(lat) and lat < MIN_LATENCY_S)
    g4 = (
        res["direction_ok"]
        and np.isfinite(res["snr"])
        and res["snr"] >= MIN_SNR
        and not artifact
    )
    print(f"[{verdict(g4)}] 게이트4 PLR 분해능  ★ 이 실험의 목적")
    print(f"        자극 횟수     {res['n_onsets']}")
    print(f"        수축 진폭     {res['amplitude']:+.5f} (pupil/iris 비)  "
          f"{'수축 — 방향 정상' if res['direction_ok'] else '확장 — 방향이 반대다'}")
    print(f"        잡음 바닥 SD  {res['baseline_sd']:.5f}")
    print(f"        SNR           {res['snr']:5.2f} 배  (기준 {MIN_SNR})")
    if np.isfinite(lat):
        print(f"        잠복기        {lat * 1000:5.0f} ms  "
              f"{'← 즉각 반응. 신경 반사가 아니라 밝기 임계 아티팩트 의심' if artifact else '(생리적 범위)'}")
    else:
        print("        잠복기        측정 불가")

    if np.isfinite(res["ae_corr"]):
        print(f"\n        참고: 자극-프레임밝기 상관 {res['ae_corr']:+.2f}")
        if abs(res["ae_corr"]) < 0.3:
            print("        상관이 낮다 — 자동 노출이 안 꺼졌을 수 있다. 화면이 밝아지면")
            print("        얼굴도 밝아져야 정상이다.")
    return g1 and g2 and g3 and g4


def plot(results: list[dict], path: Path) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return
    live = [r for r in results if r.get("curve", np.array([])).size]
    if not live:
        return
    fig, ax = plt.subplots(figsize=(8, 4.2), dpi=130)
    for r in live:
        ax.plot(r["curve_t"], r["curve"], lw=1.6, label=f"eye {r['eye']}  SNR={r['snr']:.1f}")
    ax.axvspan(0, 5, color="#F0C36A", alpha=0.22, lw=0, label="light ON")
    ax.axvline(0, color="#888", lw=0.8)
    ax.set_xlabel("time from light onset (s)")
    ax.set_ylabel("pupil / iris ratio")
    ax.set_title("Averaged pupillary light reflex")
    ax.legend(frameon=False, fontsize=8)
    ax.grid(alpha=0.18, lw=0.6)
    fig.tight_layout()
    fig.savefig(path)
    print(f"\n그래프: {path}")


def main() -> int:
    if len(sys.argv) > 1:
        p = Path(sys.argv[1])
        path = p if p.exists() else OUT / p.name
    else:
        files = sorted(OUT.glob("plr_*.csv"))
        if not files:
            print("out/ 에 CSV 가 없다. 먼저 run_plr.py 를 돌릴 것.", file=sys.stderr)
            return 1
        path = files[-1]
    print(f"입력: {path}")

    rows = load(path)
    if not rows:
        print("빈 파일이다.", file=sys.stderr)
        return 1

    results = [analyze_eye(rows, e) for e in ("A", "B")]
    results = [r for r in results if r]
    passed = [report(r) for r in results]

    plot(results, path.with_suffix(".png"))

    print(f"\n{'=' * 66}")
    if any(passed):
        print("  종합: 한쪽 눈 이상이 전 게이트 통과 — 웹캠으로 동공 측정이 성립한다.")
        print("  다음: 이 SNR 을 예산으로 보고 IPA(스트레스) 쪽을 붙일 수 있다.")
    else:
        worst = [r for r in results]
        dp = max((r["median_dprime"] for r in worst if np.isfinite(r["median_dprime"])),
                 default=float("nan"))
        print("  종합: 통과 못 함. 위 게이트 중 FAIL 항목이 원인이다.")
        if np.isfinite(dp) and dp < MIN_DPRIME:
            print(f"  d' 가 {dp:.2f} 로 낮다 → 가시광 한계일 가능성이 크다. 다음 수는")
            print("  IR 조명(850nm) + IR 통과 필터다. 알고리즘을 더 만져도 안 올라간다.")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
