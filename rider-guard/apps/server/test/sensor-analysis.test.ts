import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SensorSample } from '@rider-guard/contract';
import { analyzeImu } from '../src/services/sensor-analysis.ts';

const sample = (t: number, fields: Partial<SensorSample> = {}): SensorSample => ({ t, accG: 1, gyroDps: 0, bankDeg: 0, dv150: 0, dvValid: true, ...fields });
const analyze = (rows: SensorSample[]) => analyzeImu(rows, { dataSource: 'mock' });

test('초기 보고서의 정확한 경계값과 비동시 최근 0.5초 조건', () => {
  const rows = [sample(0), sample(0.15, { accG: 6 }), sample(0.65, { gyroDps: 300 })];
  assert.equal(analyze(rows).candidateAt, 0.65);
  assert.equal(analyze([sample(0.15, { accG: 6 }), sample(0.651, { gyroDps: 300 })]).decision, 'no_candidate');
  assert.equal(analyze([sample(0.15, { accG: 5.999, gyroDps: 300 })]).decision, 'no_candidate');
  assert.equal(analyze([sample(0.15, { accG: 6, bankDeg: -45 })]).decision, 'candidate');
  assert.equal(analyze([sample(0.15, { accG: 6, dv150: 3 })]).decision, 'candidate');
});

test('판정은 150ms 이후 시작하고 후보는 수치 하락으로 해제되지 않는다', () => {
  assert.equal(analyze([sample(0.149, { accG: 20, gyroDps: 500 })]).candidateAt, null);
  const result = analyze([sample(0.15, { accG: 6, gyroDps: 300 }), sample(1), sample(2)]);
  assert.equal(result.candidateAt, 0.15);
  assert.equal(result.decision, 'candidate');
});

test('D6/B3/C3는 mock: 정지/전도 조건 없이 후보와 DV 무효를 함께 보존', () => {
  assert.equal(analyze([sample(0.2, { accG: 3.5, gyroDps: 400 })]).decision, 'no_candidate');
  assert.equal(analyze([sample(0.2, { accG: 10, gyroDps: 300, bankDeg: 0, dv150: 0 })]).decision, 'candidate');
  const c3 = analyze([sample(0.2, { accG: 10, gyroDps: 400, dv150: null, dvValid: false, dvInvalidReason: 'packet_gap' })]);
  assert.equal(c3.decision, 'candidate');
  assert.equal(c3.quality.dvValid, false);
  assert.ok(c3.quality.dvInvalidReasons.includes('packet_gap'));
  assert.equal(c3.metadata.dataSource, 'mock');
  assert.equal(c3.evidence.find((e) => e.key === 'delta_v150')!.value, null);
});

test('입력 부족은 정상으로 바꾸지 않는다', () => {
  assert.equal(analyze([sample(0.2, { accG: 10, gyroDps: null, dv150: null, dvValid: false, bankDeg: null })]).decision, 'insufficient');
  assert.equal(analyze([]).decision, 'insufficient');
});

test('수신 시각이 같아도 센서 시간으로 중력을 제거한 벡터를 150ms 적분한다', () => {
  const rows = [0, 0.04, 0.09, 0.15, 0.2].map((t, seq) => sample(t, { seq, receivedAt: '2026-09-30T00:00:00Z', accG: 6, gyroDps: 0, dv150: undefined, dvValid: undefined, accelMps2: [20, 0, 9.80665], orientation: [1, 0, 0, 0] }));
  const result = analyze(rows);
  assert.equal(result.candidateAt, 0.15);
  assert.ok(Math.abs(result.waveform.find((r) => r.t === 0.15)!.dv150! - 3) < 1e-9);
});

test('누락/역행/동일 센서시각을 가로지르는 적분은 null, 축별 레일 접근은 별도 기록', () => {
  const rows = [0, 0.05, 0.1, 0.15, 0.15, 0.2].map((t, i) => sample(t, { seq: i < 2 ? i : i + 2, accG: 20, gyroDps: 400, dv150: undefined, dvValid: undefined, accelMps2: [30, 0, 9.80665], orientation: [1, 0, 0, 0], rawAcc: i === 3 ? [32760, 0, 0] : [100, 100, 100] }));
  const result = analyze(rows);
  assert.equal(result.decision, 'candidate');
  assert.equal(result.quality.missingPackets, 2);
  assert.equal(result.quality.timeAnomalies, 1);
  assert.equal(result.waveform.find((r) => r.t === 0.15)!.dv150, null);
  assert.deepEqual(result.quality.saturation[0]!.accAxes, [0]);
});

test('임계값 통과 시각과 이벤트 피크 시각을 구분한다', () => {
  const result = analyze([sample(0.2, { accG: 6, gyroDps: 300 }), sample(0.3, { accG: 15, gyroDps: 700 })]);
  const g = result.evidence.find((e) => e.key === 'peak_g')!;
  assert.equal(g.passedAt, 0.2);
  assert.equal(g.peakAt, 0.3);
  assert.equal(g.peak, 15);
});
