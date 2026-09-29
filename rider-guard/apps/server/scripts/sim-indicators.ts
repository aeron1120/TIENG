/**
 * MuJoCo 이륜차 사고 시뮬레이션(motorcycle_sim.py)의 results/*.csv → Rider Guard 지표.
 * 계산 정의는 시뮬레이션 실행보고서 5절의 요약표와 같다.
 *
 *   delta_v       태그 선속도(vx,vy,vz)의 100ms 간격 벡터 차이 최대값
 *   delta_v_com   라이더 질량중심 선속도(com_v*)의 같은 값 — 모델 안의 기준값일 뿐 판정에는 쓰지 않는다
 *   peak_g        태그 가속도 크기 최대 / 9.81
 *   peak_gyro     태그 각속도 크기 최대
 *   tilt_deg      몸통 기울기 최종값
 *   speed         태그 속도 크기 최종값
 *   accel_var_1s  마지막 1초 가속도 크기의 표준편차
 *
 * 최대값은 초기 안정화 구간(처음 0.15초)을 빼고 계산한다. 폰 피크 가속도는 CSV 에 없어 보내지 않는다.
 */
import type { Indicator } from '@rider-guard/contract';

export type SimRow = {
  t: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
  vx: number;
  vy: number;
  vz: number;
  com_vx: number;
  com_vy: number;
  com_vz: number;
  tilt_deg: number;
};

const COLUMNS: (keyof SimRow)[] = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'vx', 'vy', 'vz', 'com_vx', 'com_vy', 'com_vz', 'tilt_deg'];
const G = 9.81;
const SETTLE_S = 0.15;
const DV_WINDOW_S = 0.1;

export function parseSimCsv(text: string): SimRow[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0]!.split(',').map((h) => h.trim());
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`CSV 에 열이 없어요: ${missing.join(', ')}`);
  const index = COLUMNS.map((c) => header.indexOf(c));
  return lines.slice(1).map((line, n) => {
    const cells = line.split(',');
    const row = {} as SimRow;
    COLUMNS.forEach((c, i) => {
      const v = Number(cells[index[i]!]);
      if (!Number.isFinite(v)) throw new Error(`${n + 2}행 ${c} 값이 숫자가 아니에요: ${cells[index[i]!]}`);
      row[c] = v;
    });
    return row;
  });
}

const norm = (x: number, y: number, z: number) => Math.hypot(x, y, z);

/** 100ms 앞의 표본과 벡터 차이의 최대값. 표본 간격이 일정하지 않아도 시간으로 짝을 찾는다. */
function maxDeltaV(rows: SimRow[], pick: (r: SimRow) => [number, number, number]): number {
  let best = 0;
  let j = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.t - SETTLE_S < DV_WINDOW_S) continue; // 비교 대상(100ms 앞)도 안정화 구간 밖이어야 한다
    while (j < i && rows[j + 1]!.t <= r.t - DV_WINDOW_S) j++;
    const [x1, y1, z1] = pick(r);
    const [x0, y0, z0] = pick(rows[j]!);
    best = Math.max(best, norm(x1 - x0, y1 - y0, z1 - z0));
  }
  return best;
}

export function indicatorsFromSim(rows: SimRow[]): Indicator[] {
  if (rows.length < 2) throw new Error('표본이 너무 적어요.');
  const end = rows.at(-1)!;
  const settled = rows.filter((r) => r.t >= SETTLE_S);
  const lastSecond = rows.filter((r) => r.t >= end.t - 1).map((r) => norm(r.ax, r.ay, r.az));
  const mean = lastSecond.reduce((a, b) => a + b, 0) / lastSecond.length;
  const std = Math.sqrt(lastSecond.reduce((a, b) => a + (b - mean) ** 2, 0) / lastSecond.length);

  const ok = (key: string, value: number, unit: string): Indicator => ({ key, value, unit, state: 'ok', sqi: null, t: end.t });
  return [
    ok('delta_v', maxDeltaV(rows, (r) => [r.vx, r.vy, r.vz]), 'm/s'),
    ok('delta_v_com', maxDeltaV(rows, (r) => [r.com_vx, r.com_vy, r.com_vz]), 'm/s'),
    ok('peak_g', Math.max(...settled.map((r) => norm(r.ax, r.ay, r.az))) / G, 'g'),
    ok('peak_gyro', Math.max(...settled.map((r) => norm(r.gx, r.gy, r.gz))), 'rad/s'),
    ok('tilt_deg', end.tilt_deg, 'deg'),
    ok('speed', norm(end.vx, end.vy, end.vz), 'm/s'),
    ok('accel_var_1s', std, 'm/s^2'),
  ];
}
