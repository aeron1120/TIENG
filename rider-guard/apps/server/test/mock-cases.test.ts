import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MOCK_CASES } from '../src/services/mock-cases.ts';
import { analyzeImu } from '../src/services/sensor-analysis.ts';
import { setup } from './helpers.ts';

const run = (id: keyof typeof MOCK_CASES) => {
  const c = MOCK_CASES[id]();
  return { c, a: analyzeImu(c.samples, c.sensorMetadata) };
};

test('D6 mock: 각속도가 300°/s 를 넘어도 가속도 약 3.5g 라 후보 없음', () => {
  const { a } = run('D6');
  assert.equal(a.decision, 'no_candidate');
  const gyro = a.evidence.find((e) => e.key === 'peak_gyro')!;
  assert.ok(gyro.peak! >= 300);
  assert.ok(a.evidence.find((e) => e.key === 'peak_g')!.peak! < 6);
});

test('B3 mock: 속도·전도 조건 없이 가속도+ΔV 로 후보', () => {
  const { a } = run('B3');
  assert.equal(a.decision, 'candidate');
  assert.ok(Math.abs(a.evidence.find((e) => e.key === 'bank_deg')!.peak!) < 45);
  assert.ok(a.evidence.find((e) => e.key === 'peak_gyro')!.peak! < 300);
  assert.notEqual(a.evidence.find((e) => e.key === 'delta_v150')!.passedAt, null);
});

test('C3 mock: 후보와 ΔV 계산 불가를 함께 보존, 패킷 누락을 센다', () => {
  const { a } = run('C3');
  assert.equal(a.decision, 'candidate');
  assert.equal(a.quality.dvValid, false);
  assert.ok(a.quality.missingPackets > 0);
  assert.ok(a.quality.dvInvalidReasons.includes('packet_gap'));
});

test('모든 fixture 는 mock 출처를 달고, 실측처럼 센서 수신 상태를 바꾸지 않는다', async () => {
  for (const id of ['D6', 'B3', 'C3'] as const) {
    const c = MOCK_CASES[id]();
    assert.equal(c.sensorMetadata.dataSource, 'mock');
    assert.match(c.sensorMetadata.provenance ?? '', /실측 재생 아님/);
    assert.ok(c.samples.length <= 10000);
  }
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/session', { token });
  const c3 = MOCK_CASES.C3();
  const r = await t.call('POST', '/me/indicators', { token, body: { mode: 'replay', reportId: 'demo-C3', samples: c3.samples, sensorMetadata: c3.sensorMetadata } });
  assert.equal(r.status, 200);
  const detail = (await t.call('GET', `/me/incidents/${r.json.incidentId}`, { token })).json;
  assert.equal(detail.dataSource, 'mock');
  assert.equal(detail.analysis.quality.dvValid, false);
  assert.equal((await t.call('GET', '/me', { token })).json.device, null);
  await t.advance(40);
  assert.deepEqual(t.reports, []);
});
