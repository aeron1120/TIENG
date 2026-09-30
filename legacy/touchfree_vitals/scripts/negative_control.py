"""음성 대조. 확실히 각성인 상태에서 얼마나 자주 잘못 울리는가.

임계를 정하는 가장 현실적인 기준이 이것이다. 놓치는 것(미탐)은 나중에 라벨을 붙여
재야 하지만, **오탐은 라벨 없이 지금 잴 수 있다** — 각성 상태로 앉아 있기만 하면
그 구간에 뜬 경고는 전부 오탐이기 때문이다.

그리고 오탐률이 실제로는 정확도보다 중요하다. 자주 울리면 운전자가 꺼 버리고,
꺼진 시스템의 정확도는 0 이다.

    python scripts/negative_control.py record --minutes 10
    python scripts/negative_control.py report

record 는 서버에서 1Hz 로 지표를 받아 CSV 로 남긴다. 어댑터를 건드리지 않으므로
측정 대상을 바꾸지 않는다 (진단이 관측을 바꾸면 안 된다 — api/routes/diagnostics.py
가 별도 프로세스를 쓰는 것과 같은 이유다).
"""

from __future__ import annotations

import argparse
import csv
import http.cookiejar
import json
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "logs"

CHANNELS = ("drowsy_score", "drowsy_trend", "reopen_ms", "blink_dur", "blink_rate",
            "head_drop", "perclos")
FIELDS = ("t_s", "verdict", "state", *CHANNELS)


def record(base_url: str, minutes: float) -> Path:
    jar = http.cookiejar.CookieJar()
    http_ = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    http_.open(f"{base_url}/", timeout=5)
    http_.open(urllib.request.Request(f"{base_url}/api/auth/guest", method="POST"))

    OUT.mkdir(exist_ok=True)
    path = OUT / f"negcon_{datetime.now():%Y%m%d_%H%M%S}.csv"
    print(f"{minutes:.0f}분 기록. **각성 상태를 유지**하세요 — 졸리면 이 측정은 못 씁니다.")
    print(f"저장: {path}\n")

    t0 = time.monotonic()
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        next_at = t0
        while (now := time.monotonic()) - t0 < minutes * 60:
            snap = json.load(http_.open(f"{base_url}/api/snapshot"))
            by_key = {m["key"]: m for m in snap["metrics"]}
            verdict = by_key.get("drowsiness", {})
            row = {
                "t_s": f"{now - t0:.1f}",
                "verdict": verdict.get("value") or "",
                "state": verdict.get("state", ""),
            }
            for key in CHANNELS:
                value = by_key.get(key, {}).get("value")
                row[key] = "" if value is None else value
            writer.writerow(row)
            fh.flush()

            elapsed = now - t0
            if int(elapsed) % 60 == 0 and elapsed > 1:
                print(f"  {elapsed / 60:.0f}분 — 판정 {row['verdict'] or '—'}")
            next_at += 1.0
            time.sleep(max(0.0, next_at - time.monotonic()))
    return path


def report(path: Path) -> None:
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    if not rows:
        print("빈 파일이다.", file=sys.stderr)
        return

    t = np.array([float(r["t_s"]) for r in rows])
    verdict = np.array([r["verdict"] for r in rows])
    judged = verdict != ""
    total_min = (t[-1] - t[0]) / 60.0
    live_min = float(judged.sum()) / 60.0

    print(f"입력: {path.name}")
    print(f"{'=' * 62}")
    print(f"  총 {total_min:.1f}분 중 판정이 나온 구간 {live_min:.1f}분")
    if live_min <= 0:
        print("  판정이 한 번도 안 나왔다. 기준선을 못 만들었거나 눈이 안 잡혔다.")
        return

    # --- 오탐 --------------------------------------------------------- #
    warn = judged & (verdict != "awake")
    alert = judged & (verdict == "drowsy")
    # 연속으로 뜬 것은 한 번으로 센다. 운전자가 겪는 것은 '알림 횟수'다.
    bursts = int(np.sum(warn[1:] & ~warn[:-1])) + int(warn[0])
    print()
    print("  오탐 (각성 상태이므로 경고는 전부 오탐이다)")
    print(f"    주의 이상  {100 * warn.sum() / judged.sum():5.1f}% 의 시간   "
          f"{bursts / max(live_min / 60, 1e-9):5.1f} 회/시간")
    print(f"    졸음      {100 * alert.sum() / judged.sum():5.1f}% 의 시간")
    if bursts / max(live_min / 60, 1e-9) > 2:
        print("    -> 시간당 2회를 넘으면 실사용에서 꺼진다. 임계를 올려야 한다.")

    # --- 기준선 길이가 충분한가 ---------------------------------------- #
    # 어댑터는 90초 기준선의 표준편차로 z 를 만든다. 그 σ 가 나중에 비교할 구간의
    # 실제 흔들림보다 작으면 z 가 과대평가되고, 그대로 오탐이 된다.
    print()
    print("  기준선 길이별 표준편차 (창이 길수록 커지면 90초로는 부족하다는 뜻)")
    print(f"    {'채널':12s} {'30초':>9s} {'60초':>9s} {'120초':>9s} {'300초':>9s} {'전체':>9s}")
    for key in ("reopen_ms", "blink_dur", "blink_rate", "perclos"):
        series = np.array([float(r[key]) if r[key] else np.nan for r in rows])
        ok = np.isfinite(series)
        if ok.sum() < 30:
            continue
        cells = []
        for span in (30, 60, 120, 300, 10**9):
            sds = [
                float(np.nanstd(series[(t >= s) & (t < s + span) & ok]))
                for s in range(0, int(t[-1]), max(span // 2, 15))
                if ((t >= s) & (t < s + span) & ok).sum() >= 10
            ]
            cells.append(f"{np.mean(sds):9.1f}" if sds else f"{'—':>9s}")
        print(f"    {key:12s} " + " ".join(cells))
    print()
    print("  같은 채널의 σ 가 창을 늘릴수록 커진다면, 짧은 기준선은 '평소 흔들림'을")
    print("  과소평가한 것이다. z 가 부풀고 그만큼 오탐이 는다.")
    print("=" * 62)


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    rec = sub.add_parser("record")
    rec.add_argument("--minutes", type=float, default=10.0)
    rec.add_argument("--url", default="http://127.0.0.1:8001")
    rep = sub.add_parser("report")
    rep.add_argument("path", nargs="?")
    args = ap.parse_args()

    if args.cmd == "record":
        report(record(args.url, args.minutes))
        return 0

    if args.path:
        path = Path(args.path)
        path = path if path.exists() else OUT / path.name
    else:
        files = sorted(OUT.glob("negcon_*.csv"))
        if not files:
            print("logs/ 에 기록이 없다. 먼저 record 를 돌릴 것.", file=sys.stderr)
            return 1
        path = files[-1]
    report(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
