"""ESP32·MPU6050 실측 기록(REAL_*_repeat1.npz)을 서버 재생용 fixture 로 옮긴다.

    <numpy 가 있는 python> scripts/export-measured.py
    (예: ../../../legacy/moto_sensing/pcx125_sim/.venv/Scripts/python.exe scripts/export-measured.py)

- 판정 구간만 자른다: 사건 중심 1.0초 전 ~ 0.5초 후. 잘라낸 밖에서 실험 판정이 먼저 걸렸으면 멈춘다.
- 센서 시각·순번·원시 코드·가속도/각속도 크기·추정 뱅크각·추정 ΔV 를 그대로 옮긴다. NaN ΔV 는 null + 사유.
- 참조 채널(dv_true·roll_true·latent_*)은 출처가 확인되지 않아 옮기지 않는다 (MEASUREMENT_metadata.json).
- 실험 당시 첫 후보 시각(candidate_latched)은 기대값으로 함께 적어 서버 규칙과 비교한다.
"""
import csv
import gzip
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SRC = HERE.parents[3] / 'legacy' / 'moto_sensing' / 'ESP32_MPU6050' / 'data'
OUT = HERE.parent / 'fixtures' / 'measured'
BEFORE_S, AFTER_S, WARMUP_S = 1.0, 0.5, 0.15


def r(x, d):
    return None if x is None or not np.isfinite(x) else round(float(x), d)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with open(SRC / 'REAL_summary_29.csv', encoding='utf-8-sig') as f:
        summary = {row['scenario']: row for row in csv.DictReader(f)}
    index = []
    for sid, row in summary.items():
        z = np.load(SRC / f'REAL_{sid}_repeat1.npz')
        t, latch = z['t'], z['candidate_latched']
        center = float(z['event_center_s'])
        start, end = max(0.0, center - BEFORE_S), center + AFTER_S
        latch_at = float(t[np.argmax(latch)]) if latch.any() else None
        if latch_at is not None and not (start <= latch_at <= end):
            raise SystemExit(f'{sid}: 실험 후보 {latch_at}s 가 잘라낸 구간 밖')
        keep = (t >= start) & (t <= end)
        acc_g = np.linalg.norm(z['a'], axis=1)
        gyro = np.linalg.norm(z['g'], axis=1)
        cols = {k: [] for k in ('t', 'seq', 'accG', 'gyroDps', 'bankDeg', 'dv150', 'dvReason', 'rawAcc', 'rawGyro')}
        for i in np.flatnonzero(keep):
            dv = r(z['dv_est'][i], 4)
            invalid = bool(z['dv_invalid'][i]) or dv is None
            cols['t'].append(r(t[i], 6))
            cols['seq'].append(int(z['seq'][i]))
            cols['accG'].append(r(acc_g[i], 4))
            cols['gyroDps'].append(r(gyro[i], 2))
            cols['bankDeg'].append(r(z['roll_est'][i], 3))
            cols['dv150'].append(None if invalid else dv)
            # 초기 150ms 는 적분 이력 부족, 그 뒤 무효는 순번 누락을 가로지르는 창 (README 수치 검증 범위)
            cols['dvReason'].append(None if not invalid else 'history_short' if t[i] < WARMUP_S else 'packet_gap')
            cols['rawAcc'].append([int(v) for v in z['acc_raw'][i]])
            cols['rawGyro'].append([int(v) for v in z['gyro_raw'][i]])
        case = {
            'id': sid, 'name': row['name'], 'class': row['class'],
            'reportCandidates': int(row['candidate_count']), 'latchAt': r(latch_at, 6),
            'window': {'from': r(start, 6), 'to': r(end, 6)}, 'columns': cols,
        }
        with gzip.open(OUT / f'{sid}.json.gz', 'wt', encoding='utf-8') as f:
            json.dump(case, f, ensure_ascii=False, separators=(',', ':'))
        index.append(sid)
        print(f'{sid}: {int(keep.sum())} 표본, 실험 후보 {latch_at}')
    print(f'{len(index)}건 → {OUT}')


if __name__ == '__main__':
    main()
