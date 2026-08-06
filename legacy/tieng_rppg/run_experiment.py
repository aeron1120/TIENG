"""
3개 시나리오(static/lighting/head_motion)를 순서대로 자동 녹화하는 실험 러너.
각 시나리오를 rppg_demo_v4.py --duration 으로 고정 시간 실행하고,
experiments/<타임스탬프>/ 에 CSV를 모은 뒤 콘솔에 시나리오별 요약표를 출력한다.

실행
    python run_experiment.py
    python run_experiment.py --duration 90 --camera 1
"""
from __future__ import annotations

import argparse
import csv
import subprocess
import sys
import time
from pathlib import Path
from typing import List

import numpy as np

SCENARIOS = ["static", "lighting", "head_motion"]
INSTRUCTIONS = {
    "static": "카메라를 향해 편안히 앉아 최대한 움직이지 마세요.",
    "lighting": "녹화 중간에 조명을 크게 바꿔보세요 (어둡게 → 밝게 등).",
    "head_motion": "고개를 천천히 좌우로 움직이며 진행하세요.",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="static/lighting/head_motion 3시나리오 자동 실험 러너")
    p.add_argument("--duration", type=float, default=60.0, help="시나리오당 녹화 시간(초)")
    p.add_argument("--camera", type=int, default=0)
    p.add_argument("--out-dir", type=str, default="experiments")
    return p.parse_args()


def run_scenario(scenario: str, duration: float, camera: int, out_csv: Path) -> bool:
    print(f"\n=== [{scenario}] {INSTRUCTIONS[scenario]} ===")
    input(f"준비되면 Enter를 누르세요 ({duration:.0f}초간 녹화 후 자동 종료) ... ")
    cmd = [
        sys.executable, "rppg_demo_v4.py",
        "--scenario", scenario,
        "--duration", str(duration),
        "--camera", str(camera),
        "--log", str(out_csv),
    ]
    result = subprocess.run(cmd)
    return result.returncode == 0


def _mean(values: List[float]) -> float:
    return float(np.mean(values)) if values else float("nan")


def summarize(out_dir: Path) -> None:
    print("\n=== 시나리오 요약 ===")
    rows = []
    for scenario in SCENARIOS:
        csv_path = out_dir / f"{scenario}.csv"
        if not csv_path.exists():
            continue
        with open(csv_path, newline="", encoding="utf-8") as f:
            records = list(csv.DictReader(f))
        ok = [r for r in records if r["heart_status"] == "ok"]
        rows.append({
            "scenario": scenario,
            "frames": len(records),
            "coverage_%": round(100 * len(ok) / len(records), 1) if records else 0.0,
            "hr_mean": round(_mean([float(r["heart_bpm"]) for r in ok if r["heart_bpm"]]), 1),
            "hr_sqi_mean": round(_mean([float(r["heart_sqi"]) for r in ok]), 2),
            "fps_mean": round(_mean([float(r["fps"]) for r in records]), 1),
        })
    if not rows:
        print("(수집된 CSV 없음)")
        return
    header = f"{'scenario':<12}{'frames':>8}{'coverage_%':>12}{'hr_mean':>10}{'hr_sqi_mean':>13}{'fps_mean':>10}"
    print(header)
    for r in rows:
        print(f"{r['scenario']:<12}{r['frames']:>8}{r['coverage_%']:>12}{r['hr_mean']:>10}"
              f"{r['hr_sqi_mean']:>13}{r['fps_mean']:>10}")


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir) / time.strftime("%Y-%m-%d_%H%M")
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"결과 저장 위치: {out_dir}")

    for scenario in SCENARIOS:
        out_csv = out_dir / f"{scenario}.csv"
        ok = run_scenario(scenario, args.duration, args.camera, out_csv)
        if not ok:
            print(f"[{scenario}] 실행 실패(카메라 오류 등) - 실험 중단.")
            return 1

    summarize(out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
