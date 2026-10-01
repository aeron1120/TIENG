import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import type { DemoCaseDto, DemoCaseSummaryDto, DemoResultsDto, OpsRuleCheckDto, SensorAnalysis, SensorMetadata, SensorSample, Vector3 } from '@rider-guard/contract';

import { analyzeImu, PPT_DRAFT_RULE, SENSOR_RULE } from './sensor-analysis.ts';

/**
 * ESP32·MPU6050 헬멧 IMU 실측 기록 재생 (legacy/moto_sensing/ESP32_MPU6050/data/REAL_*_repeat1.npz → fixtures/esp32).
 * 29조건 1회차, 사건 중심 -1.0 ~ +0.5초. scripts/export-esp32.py 로 다시 만든다.
 *
 * 출처: 시나리오별로 직접 실험한 실측 자료다(2026-10-01 사용자 확인). 보고서 파일 이름의 'MOCK'은 이름만 그렇게 붙었다.
 * 보드 ID·펌웨어·측정일은 기록이 없어 null 로 둔다. 같은 조건의 시뮬레이션 이론값과 함께 비교한다.
 * 참조 채널(dv_true 등)은 출처가 정리되지 않아 옮기지 않았다. 이 재생은 정답 비교가 아니라
 * '기록에 남은 판정(candidate_latched)을 서버 규칙이 같은 시각에 재현하는가'를 본다.
 */
export const ESP32_CASE_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3',
  'C4', 'C5', 'C6', 'C7', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9',
] as const;
export type Esp32CaseId = (typeof ESP32_CASE_IDS)[number];

export const ESP32_SOURCE = {
  dataSource: 'measured' as const,
  label: 'ESP32·MPU6050 헬멧 IMU 실측',
  note: '시나리오별 실측 — 29조건 × 5회(145회) 요약과 1회차 원본 파형. 보드 ID·펌웨어·측정일은 기록 없음',
};

type Repeats = { n: number; peakG: [number, number]; peakDps: [number, number]; dvEst: [number, number]; candidates: number };
type SimRef = { speedKmh: number | null; peakG: number | null; peakDps: number | null; dvTrue: number | null; candidateS: number | null };
export type Esp32Case = {
  id: Esp32CaseId;
  name: string;
  /** 보고서 분류 — accident / boundary / unrealized / normal */
  class: string;
  /** 보고서 5회 중 후보 수 */
  reportCandidates: number;
  /** 이 1회차 기록에 남은 첫 후보 시각(초). 없으면 null */
  latchAt: number | null;
  window: { from: number; to: number };
  repeats: Repeats;
  sim: SimRef;
  samples: SensorSample[];
  sensorMetadata: SensorMetadata;
};

type Columns = {
  t: number[]; seq: number[]; accG: (number | null)[]; gyroDps: (number | null)[]; bankDeg: (number | null)[];
  dv150: (number | null)[]; dvReason: (string | null)[]; rawAcc: Vector3[]; rawGyro: Vector3[];
};
type Stored = Omit<Esp32Case, 'samples' | 'sensorMetadata'> & { columns: Columns };

export const isEsp32CaseId = (id: string): id is Esp32CaseId => (ESP32_CASE_IDS as readonly string[]).includes(id);

const cache = new Map<Esp32CaseId, Esp32Case>();

export function loadEsp32Case(id: Esp32CaseId): Esp32Case {
  const hit = cache.get(id);
  if (hit) return hit;
  const file = new URL(`../../fixtures/esp32/${id}.json.gz`, import.meta.url);
  const { columns: c, ...rest } = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Stored;
  const samples: SensorSample[] = c.t.map((t, i) => ({
    t, seq: c.seq[i], accG: c.accG[i], gyroDps: c.gyroDps[i], bankDeg: c.bankDeg[i],
    dv150: c.dv150[i], dvValid: c.dv150[i] !== null, dvInvalidReason: c.dvReason[i],
    rawAcc: c.rawAcc[i], rawGyro: c.rawGyro[i],
  }));
  const loaded: Esp32Case = {
    ...rest,
    samples,
    sensorMetadata: {
      dataSource: ESP32_SOURCE.dataSource,
      sampleRateHz: 1000,
      accRangeG: 16,
      gyroRangeDps: 2000,
      filter: null,
      calibration: null,
      mount: null,
      provenance: `${ESP32_SOURCE.label} ${id} 1회차 (${rest.name}) — ${ESP32_SOURCE.note}. ΔV·뱅크각은 기록 당시 추정값`,
    },
  };
  cache.set(id, loaded);
  return loaded;
}

/** 같은 표본에서 걸렸는지 — 1kHz 기록의 반 표본 */
const SAME_SAMPLE_S = 0.0005;

type Judged = { c: Esp32Case; v1: SensorAnalysis; ppt: SensorAnalysis; match: boolean };
const judged = new Map<Esp32CaseId, Judged>();

function judge(id: Esp32CaseId): Judged {
  const hit = judged.get(id);
  if (hit) return hit;
  const c = loadEsp32Case(id);
  const v1 = analyzeImu(c.samples, c.sensorMetadata);
  const ppt = analyzeImu(c.samples, c.sensorMetadata, PPT_DRAFT_RULE);
  // 후보가 없는 조건은 no_candidate 든 insufficient(순번 누락이 판정창에 있음)든 일치로 본다 —
  // 기록도 '후보 없음'만 남겼고, 누락 표시는 규칙이 지킨 보수적 표시다.
  const match = c.latchAt === null ? v1.candidateAt === null : v1.candidateAt !== null && Math.abs(v1.candidateAt - c.latchAt) <= SAME_SAMPLE_S;
  const out = { c, v1, ppt, match };
  judged.set(id, out);
  return out;
}

const passedKeys = (a: SensorAnalysis) => a.evidence.filter((e) => e.passedAt !== null).map((e) => e.key);

/** 운영 모니터: 지금 규칙을 29조건에 다시 돌려 기록의 판정과 대조한다 */
export function esp32RuleCheck(): OpsRuleCheckDto {
  const items = ESP32_CASE_IDS.map((id) => {
    const { c, v1, match } = judge(id);
    return {
      id, name: c.name, class: c.class, expectedAt: c.latchAt, decision: v1.decision, candidateAt: v1.candidateAt, match,
      passed: passedKeys(v1), missingPackets: v1.quality.missingPackets, dvValid: v1.quality.dvValid,
    };
  });
  return { ruleVersion: SENSOR_RULE.version, dataSource: ESP32_SOURCE.dataSource, matched: items.filter((i) => i.match).length, total: items.length, items };
}

function summary(id: Esp32CaseId): DemoCaseSummaryDto {
  const { c, v1, ppt, match } = judge(id);
  return {
    id, name: c.name, class: c.class, latchAt: c.latchAt, repeats: c.repeats, sim: c.sim,
    v1: { decision: v1.decision, candidateAt: v1.candidateAt, passed: passedKeys(v1), match },
    ppt: { decision: ppt.decision, candidateAt: ppt.candidateAt, passed: passedKeys(ppt) },
    quality: {
      missingPackets: v1.quality.missingPackets, dvValid: v1.quality.dvValid, dvValidRatio: v1.quality.dvValidRatio,
      saturated: v1.quality.saturation.length,
    },
    peaks: Object.fromEntries(v1.evidence.map((e) => [e.key, e.peak])) as DemoCaseSummaryDto['peaks'],
  };
}

/** 결과 비교 화면 — 29조건 요약 (파형 없음) */
export function esp32Results(): DemoResultsDto {
  const items = ESP32_CASE_IDS.map(summary);
  return {
    source: ESP32_SOURCE,
    rules: { v1: { ...SENSOR_RULE }, ppt: { ...PPT_DRAFT_RULE } },
    items,
    matched: items.filter((i) => i.v1.match).length,
  };
}

/** 시연·결과 상세 — 운영 규칙 분석(파형 포함)과 발표자료 기준 분석 요약 */
export function esp32Case(id: Esp32CaseId): DemoCaseDto {
  const { v1 } = judge(id);
  return { source: ESP32_SOURCE, summary: summary(id), analysis: v1 };
}
