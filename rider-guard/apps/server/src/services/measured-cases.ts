import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import type { OpsRuleCheckDto, SensorMetadata, SensorSample, Vector3 } from '@rider-guard/contract';

import { analyzeImu, SENSOR_RULE } from './sensor-analysis.ts';

/**
 * ESP32·MPU6050 실측 기록 재생 (legacy/moto_sensing/ESP32_MPU6050/data/REAL_*_repeat1.npz → fixtures/measured).
 * 29조건 1회차, 사건 중심 -1.0 ~ +0.5초. scripts/export-measured.py 로 다시 만든다.
 *
 * 출처: 사용자가 2026-09-30 실측이라고 확인한 자료. 보드 ID·펌웨어·측정일은 기록이 없어 null 로 둔다.
 * 참조 채널(dv_true 등)은 출처가 확인되지 않아 옮기지 않았다 — 이 재생은 정답 비교가 아니라
 * '실험 당시 후보 판정(candidate_latched)을 서버 규칙이 같은 시각에 재현하는가'를 본다.
 */
export const MEASURED_CASE_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3',
  'C4', 'C5', 'C6', 'C7', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9',
] as const;
export type MeasuredCaseId = (typeof MEASURED_CASE_IDS)[number];
export type MeasuredCase = {
  id: MeasuredCaseId;
  name: string;
  /** 보고서 분류 — accident / boundary / unrealized / normal */
  class: string;
  /** 보고서 5회 중 후보 수 */
  reportCandidates: number;
  /** 이 1회차에서 실험 판정이 처음 후보를 잡은 센서 시각(초). 없으면 null */
  latchAt: number | null;
  window: { from: number; to: number };
  samples: SensorSample[];
  sensorMetadata: SensorMetadata;
};

type Columns = {
  t: number[]; seq: number[]; accG: (number | null)[]; gyroDps: (number | null)[]; bankDeg: (number | null)[];
  dv150: (number | null)[]; dvReason: (string | null)[]; rawAcc: Vector3[]; rawGyro: Vector3[];
};
type Stored = Omit<MeasuredCase, 'samples' | 'sensorMetadata'> & { columns: Columns };

export const isMeasuredCaseId = (id: string): id is MeasuredCaseId => (MEASURED_CASE_IDS as readonly string[]).includes(id);

const cache = new Map<MeasuredCaseId, MeasuredCase>();

export function loadMeasuredCase(id: MeasuredCaseId): MeasuredCase {
  const hit = cache.get(id);
  if (hit) return hit;
  const file = new URL(`../../fixtures/measured/${id}.json.gz`, import.meta.url);
  const { columns: c, ...rest } = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Stored;
  const samples: SensorSample[] = c.t.map((t, i) => ({
    t, seq: c.seq[i], accG: c.accG[i], gyroDps: c.gyroDps[i], bankDeg: c.bankDeg[i],
    dv150: c.dv150[i], dvValid: c.dv150[i] !== null, dvInvalidReason: c.dvReason[i],
    rawAcc: c.rawAcc[i], rawGyro: c.rawGyro[i],
  }));
  const loaded: MeasuredCase = {
    ...rest,
    samples,
    sensorMetadata: {
      dataSource: 'measured',
      sampleRateHz: 1000,
      accRangeG: 16,
      gyroRangeDps: 2000,
      filter: null,
      calibration: null,
      mount: null,
      provenance: `ESP32·MPU6050 ${id} 1회차 (${rest.name}) — 사용자 확인 실측(2026-09-30). 보드·펌웨어·측정일 기록 없음. ΔV·뱅크각은 기록 당시 추정값`,
    },
  };
  cache.set(id, loaded);
  return loaded;
}

/** 같은 표본에서 걸렸는지 — 1kHz 기록의 반 표본 */
const SAME_SAMPLE_S = 0.0005;

/**
 * 지금 규칙을 29조건에 다시 돌려 실험 판정과 대조한다. 후보 여부와 첫 후보 시각이 같아야 일치.
 * 후보가 없는 조건은 no_candidate 든 insufficient(순번 누락이 판정창에 있음)든 일치로 본다 —
 * 실험 판정도 '후보 없음'만 기록했고, 누락 표시는 규칙이 지킨 보수적 표시다.
 */
export function measuredRuleCheck(): OpsRuleCheckDto {
  const items = MEASURED_CASE_IDS.map((id) => {
    const c = loadMeasuredCase(id);
    const a = analyzeImu(c.samples, c.sensorMetadata);
    const match = c.latchAt === null
      ? a.candidateAt === null
      : a.candidateAt !== null && Math.abs(a.candidateAt - c.latchAt) <= SAME_SAMPLE_S;
    return {
      id, name: c.name, class: c.class, expectedAt: c.latchAt, decision: a.decision, candidateAt: a.candidateAt, match,
      passed: a.evidence.filter((e) => e.passedAt !== null).map((e) => e.key),
      missingPackets: a.quality.missingPackets, dvValid: a.quality.dvValid,
    };
  });
  return { ruleVersion: SENSOR_RULE.version, dataSource: 'measured', matched: items.filter((i) => i.match).length, total: items.length, items };
}
