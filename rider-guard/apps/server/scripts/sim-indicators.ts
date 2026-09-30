/**
 * 헬멧 IMU 시뮬레이션 CSV → Rider Guard 지표 보고. 계약(packages/contract '보내는 쪽 규약')의 기준 구현이다 —
 * 실제 태그 펌웨어도 이 순서대로 만들면 서버 판정이 실험의 사고 후보 규칙과 같아진다.
 *
 * 읽는 형식 (둘 다 IMU 로 계산한 열만 쓴다. 태그 실제 속도·차체 기울기 같은 시뮬레이터 참조값은 탐지 입력이 아니다):
 *   팀 telemetry.py 출력     t_s, imu_acc_norm_g, imu_gyro_norm_dps, imu_bank_est_deg, imu_delta_v150_mps (run_id 로 여러 실행)
 *   발표 자료 센서 프로파일  t_s, acc_norm_g, gyro_norm_dps, bank_est_deg, delta_v150_mps (data/runs/<id>/<profile>.csv.gz)
 */
import type { Indicator, SensorAnalysis, SensorSample, SensorMetadata } from '@rider-guard/contract';
import { analyzeImu } from '../src/services/sensor-analysis.ts';

export type ImuRow = {
  t: number;
  accG: number;
  gyroDps: number;
  bankDeg: number;
  /** 150ms 이력이 쌓이기 전에는 NaN — 0 으로 메우지 않는다 */
  dv150: number;
};

export type SimReport = { tPeak: number; indicators: Indicator[]; samples: SensorSample[]; sensorMetadata: SensorMetadata; analysis: SensorAnalysis };

/** 실험의 초기 판단 유예. 이 앞의 표본은 이벤트·최대값 어디에도 쓰지 않는다 */
const WARMUP_S = 0.15;
/** 이벤트를 여는 가속도. 서버 충격 임계값(4g)보다 낮게 둬서 아슬아슬하게 기각된 정상 충격도 기록에 남긴다 */
const WAKE_G = 3;
/** 보조 지표를 모으는 창: 충격 최대 시각 앞뒤. 실험의 '지표 동시 발생 구간' 0.5초와 같다 */
const WINDOW_S = 0.5;
/**
 * 3g 이상 표본이 이만큼 없으면 이벤트를 닫는다. 창과 같게 둔다 — 추돌 뒤 0.8초에 머리를 한 번 더 부딪친 B3 처럼
 * 충격이 둘이면 창도 둘이어야 첫 충격 직후의 회전을 놓치지 않는다.
 */
const CLOSE_GAP_S = WINDOW_S;
/** 충격 뒤 무동작을 지켜보는 시간 (설계문서 5.1 '30초 정적') */
const OBSERVE_S = 30;

const COLUMNS: Record<keyof ImuRow, string[]> = {
  t: ['t_s'],
  accG: ['imu_acc_norm_g', 'acc_norm_g'],
  gyroDps: ['imu_gyro_norm_dps', 'gyro_norm_dps'],
  bankDeg: ['imu_bank_est_deg', 'bank_est_deg'],
  dv150: ['imu_delta_v150_mps', 'delta_v150_mps'],
};

/** 실행 이름 → 표본. run_id 열이 없으면 이름이 null 인 실행 하나다. */
export function parseImuCsv(text: string): Map<string | null, ImuRow[]> {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = lines[0]!.split(',').map((h) => h.trim());
  const index = {} as Record<keyof ImuRow, number>;
  const missing: string[] = [];
  for (const [key, names] of Object.entries(COLUMNS) as [keyof ImuRow, string[]][]) {
    index[key] = header.findIndex((h) => names.includes(h));
    if (index[key] < 0) missing.push(names.join('|'));
  }
  if (missing.length) throw new Error(`CSV 에 열이 없어요: ${missing.join(', ')}`);
  const runIndex = header.indexOf('run_id');
  const scenarioIndex = header.indexOf('scenario_id');

  const runs = new Map<string | null, ImuRow[]>();
  lines.slice(1).forEach((line, n) => {
    const cells = line.split(',');
    const row = {} as ImuRow;
    for (const key of Object.keys(COLUMNS) as (keyof ImuRow)[]) {
      const cell = cells[index[key]]?.trim() ?? '';
      const v = cell === '' || cell.toLowerCase() === 'nan' ? NaN : Number(cell);
      if (!Number.isFinite(v) && !(key === 'dv150' && Number.isNaN(v))) throw new Error(`${n + 2}행 ${COLUMNS[key][0]} 값이 숫자가 아니에요: ${cell}`);
      row[key] = v;
    }
    const run = runIndex < 0 ? null : [cells[scenarioIndex], cells[runIndex]].filter(Boolean).join(':');
    const rows = runs.get(run) ?? [];
    if (rows.length && row.t <= rows.at(-1)!.t) throw new Error(`${n + 2}행 시간이 줄었어요 (${run ?? ''} t=${row.t})`);
    rows.push(row);
    runs.set(run, rows);
  });
  return runs;
}

/** 팀 telemetry.py 의 quiet 정의와 같다 */
const isQuiet = (r: ImuRow) => Math.abs(r.accG - 1) < 0.15 && r.gyroDps < 30;

/** 3g 이상 이벤트마다 보고 하나. 3g 를 한 번도 넘지 않은 실행은 보낼 것이 없다. */
export function reportsFromImu(rows: ImuRow[]): SimReport[] {
  const settled = rows.filter((r) => r.t >= WARMUP_S);
  const groups: { first: ImuRow; last: ImuRow; peak: ImuRow }[] = [];
  let last = -Infinity;
  for (const r of settled) {
    if (r.accG < WAKE_G) continue;
    if (r.t - last > CLOSE_GAP_S) groups.push({ first: r, last: r, peak: r });
    else {
      const group = groups.at(-1)!;
      group.last = r;
      if (r.accG > group.peak.accG) group.peak = r;
    }
    last = r.t;
  }
  return groups.map(({ first, last, peak }) => {
    const samples: SensorSample[] = rows.filter((r) => r.t >= first.t - WINDOW_S && r.t <= last.t + WINDOW_S).map((r) => ({ ...r, dv150: Number.isFinite(r.dv150) ? r.dv150 : null, dvValid: Number.isFinite(r.dv150), dvInvalidReason: Number.isFinite(r.dv150) ? null : 'upstream_invalid' }));
    // A file name is not provenance. Only an independently documented source may upgrade this.
    const sensorMetadata: SensorMetadata = { dataSource: 'mock', provenance: 'CSV source not independently verified' };
    const analysis = analyzeImu(samples, sensorMetadata);
    const indicators = indicatorsAt(rows, settled, peak);
    return { tPeak: peak.t, indicators, samples, sensorMetadata, analysis };
  });
}

function indicatorsAt(rows: ImuRow[], settled: ImuRow[], peak: ImuRow): Indicator[] {
  const window = settled.filter((r) => Math.abs(r.t - peak.t) <= WINDOW_S);
  const dvs = window.map((r) => r.dv150).filter((v) => !Number.isNaN(v));

  // 보고 시각까지 관찰한 무동작. 기록이 그 전에 끝나면 끝까지의 값을 품질 미달로 보낸다 — 이어서 가만히 있었을지는 모른다.
  const reportAt = peak.t + OBSERVE_S;
  const observed = rows.filter((r) => r.t <= reportAt);
  const end = observed.at(-1)!;
  let quietSince: number | null = null;
  for (const r of observed) quietSince = isQuiet(r) ? (quietSince ?? r.t) : null;
  const complete = rows.at(-1)!.t >= reportAt;

  const at = end.t;
  const ok = (key: string, value: number, unit: string, t: number): Indicator => ({ key, value, unit, state: 'ok', sqi: null, t });
  const maxAt = (field: 'gyroDps' | 'dv150' | 'bankDeg') => window.reduce((best, r) => Number.isFinite(r[field]) && (!Number.isFinite(best[field]) || Math.abs(r[field]) > Math.abs(best[field])) ? r : best, window[0]!);
  return [
    ok('peak_g', peak.accG, 'g', peak.t),
    ok('peak_gyro', maxAt('gyroDps').gyroDps, 'deg/s', maxAt('gyroDps').t),
    dvs.length ? ok('delta_v150', Math.max(...dvs), 'm/s', maxAt('dv150').t) : { key: 'delta_v150', value: null, unit: 'm/s', state: 'low_quality', sqi: null, t: peak.t },
    ok('bank_deg', Math.abs(maxAt('bankDeg').bankDeg), 'deg', maxAt('bankDeg').t),
    { ...ok('quiet_s', quietSince == null ? 0 : end.t - quietSince, 's', at), state: complete ? 'ok' : 'low_quality' },
  ];
}
