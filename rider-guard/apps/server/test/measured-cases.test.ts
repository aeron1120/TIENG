import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadMeasuredCase, MEASURED_CASE_IDS, measuredRuleCheck } from '../src/services/measured-cases.ts';
import { analyzeImu } from '../src/services/sensor-analysis.ts';
import { setup } from './helpers.ts';

const run = (id: (typeof MEASURED_CASE_IDS)[number]) => {
  const c = loadMeasuredCase(id);
  return { c, a: analyzeImu(c.samples, c.sensorMetadata) };
};

test('실측 29조건: 서버 규칙이 실험 판정의 후보 여부와 첫 후보 시각(같은 표본)을 재현한다', () => {
  const check = measuredRuleCheck();
  assert.equal(check.total, 29);
  assert.deepEqual(check.items.filter((i) => !i.match).map((i) => i.id), []);
  assert.equal(check.ruleVersion, 'imu-report-v1');
});

test('실측 정상 주행·미재현·스침은 후보가 없고, 사고·저속 전도(C9)는 후보다', () => {
  for (const id of MEASURED_CASE_IDS) {
    const { c, a } = run(id);
    const expected = c.class === 'accident' || id === 'C9';
    assert.equal(a.decision === 'candidate', expected, `${id} ${c.name}`);
    assert.equal(c.reportCandidates > 0, expected, `${id} 보고서 후보 수`);
  }
});

test('실측 D6 연석: 각속도는 300°/s 를 넘지만 가속도 3.5g 라 후보 없음', () => {
  const { a } = run('D6');
  assert.equal(a.candidateAt, null);
  assert.ok(a.evidence.find((e) => e.key === 'peak_gyro')!.peak! >= 300);
  assert.ok(a.evidence.find((e) => e.key === 'peak_g')!.peak! < 6);
});

test('실측 B3 정지 중 피추돌: 뱅크각 없이 가속도+각속도로 후보', () => {
  const { a } = run('B3');
  assert.equal(a.decision, 'candidate');
  assert.equal(a.evidence.find((e) => e.key === 'bank_deg')!.passedAt, null);
  assert.notEqual(a.evidence.find((e) => e.key === 'peak_gyro')!.passedAt, null);
});

test('실측 C3 충격 구간 누락: 후보와 ΔV 계산 불가·패킷 누락을 함께 남긴다', () => {
  const { a } = run('C3');
  assert.equal(a.decision, 'candidate');
  assert.equal(a.quality.dvValid, false);
  assert.ok(a.quality.missingPackets > 0);
  assert.ok(a.quality.dvInvalidReasons.includes('packet_gap'));
});

test('실측 정상 주행은 판정창에 순번 누락이 있으면 후보 없음 대신 판정 정보 부족으로 남는다 (현재 규칙 동작)', () => {
  // D7·D9 는 구간 안 누락이 없어 no_candidate, 나머지 정상 주행은 1~3개 누락으로 insufficient.
  // 누락 한 표본을 '후보 없음'으로 볼지는 새 규칙 버전으로 따로 검증할 일이다.
  assert.equal(run('D7').a.decision, 'no_candidate');
  const d1 = run('D1').a;
  assert.equal(d1.decision, 'insufficient');
  assert.ok(d1.quality.missingPackets > 0);
});

test('실측 출처를 달고, 참조 채널은 싣지 않는다', () => {
  const c = loadMeasuredCase('A1');
  assert.equal(c.sensorMetadata.dataSource, 'measured');
  assert.match(c.sensorMetadata.provenance ?? '', /보드·펌웨어·측정일 기록 없음/);
  assert.equal(c.sensorMetadata.mount, null);
  assert.ok(c.samples.length <= 10000);
  assert.ok(!('dv_true' in c.samples[0]));
});

test('운영 모니터 /ops/api/rule-check 는 토큰이 있어야 보이고 29건을 돌려준다', async () => {
  const t = await setup();
  assert.equal((await t.call('GET', '/ops/api/rule-check')).status, 401);
  const r = await t.ops('GET', '/rule-check');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 29);
  assert.equal(r.json.matched, 29);
});
