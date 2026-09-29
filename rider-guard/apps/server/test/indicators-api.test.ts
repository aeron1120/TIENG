import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Indicator } from '@rider-guard/contract';

import { setup } from './helpers.ts';

const indicators = (v: { peak_g: number; peak_gyro: number; delta_v150: number; bank_deg: number; quiet_s: number }): Indicator[] => [
  { key: 'peak_g', value: v.peak_g, unit: 'g', state: 'ok', sqi: null, t: 30 },
  { key: 'peak_gyro', value: v.peak_gyro, unit: 'deg/s', state: 'ok', sqi: null, t: 30 },
  { key: 'delta_v150', value: v.delta_v150, unit: 'm/s', state: 'ok', sqi: null, t: 30 },
  { key: 'bank_deg', value: v.bank_deg, unit: 'deg', state: 'ok', sqi: null, t: 30 },
  { key: 'quiet_s', value: v.quiet_s, unit: 's', state: 'ok', sqi: null, t: 30 },
];
// 헬멧 IMU 실험의 A1_v00(정지 승용차 측면 충돌)·D6_v09(연석) 값. 기울기·무동작은 실험 표에 없어 넣은 값이다
const CRASH = indicators({ peak_g: 23.41, peak_gyro: 1366, delta_v150: 3.92, bank_deg: 0, quiet_s: 25 });
const BUMP = indicators({ peak_g: 4.74, peak_gyro: 375, delta_v150: 2.86, bank_deg: 0, quiet_s: 28 });

/** 지표 백엔드를 기기로 등록하고 라이더와 페어링, 운행 시작 */
async function pairedBackend(t: Awaited<ReturnType<typeof setup>>, { drive = true } = {}) {
  const token = await t.login();
  await t.call('POST', '/me/contacts', { token, body: { name: '엄마', relation: 'family', phone: '01011111111' } });
  const reg = (await t.call('POST', '/device-api/register', { body: { name: '지표 백엔드', kind: 'tag' } })).json;
  await t.call('POST', '/me/device', { token, body: { pairingCode: reg.pairingCode } });
  if (drive) await t.call('POST', '/me/session', { token });
  const send = (body: object) => t.call('POST', '/device-api/indicators', { body, headers: { authorization: `Device ${reg.deviceToken}` } });
  return { token, send };
}

test('지표 백엔드가 보낸 사고 지표로 사고가 열리고, 이후는 기존 에스컬레이션 그대로 흐른다', async () => {
  const t = await setup();
  const { token, send } = await pairedBackend(t);

  const res = await send({ indicators: CRASH, producer: 'tag-v1', reportId: 'ses1:ev7' });
  assert.equal(res.status, 200);
  assert.equal(res.json.decision, 'alarm');
  assert.equal(res.json.action, 'incident_created');

  const active = (await t.call('GET', '/me/incidents/active', { token })).json.incident;
  assert.equal(active.id, res.json.incidentId);
  assert.equal(active.status, 'countdown');
  assert.equal(active.source, 'device');
  assert.equal(active.kind, 'impact');

  await t.advance(30); // 무응답 → 비상연락 + 119 자동 신고
  const detail = (await t.ops('GET', `/incidents/${active.id}`)).json;
  assert.equal(detail.evidence.decision, 'alarm');
  assert.equal(detail.evidence.producer, 'tag-v1');
  assert.equal(detail.evidence.traces.find((x: { rule: string }) => x.rule === 'impact').inputs.peak_g, 23.41);
  assert.ok(t.sms.some((s) => s.to === '01011111111' && s.body.includes('응답이 없었어요')));
});

test('같은 보고를 다시 보내도 사고는 한 번만 — 괜찮아요로 끝난 뒤에도 다시 열지 않는다', async () => {
  const t = await setup();
  const { token, send } = await pairedBackend(t);
  const first = (await send({ indicators: CRASH, reportId: 'ses1:ev7' })).json;
  await t.call('POST', `/me/incidents/${first.incidentId}/respond`, { token, body: { response: 'ok' } });

  const again = (await send({ indicators: CRASH, reportId: 'ses1:ev7' })).json;
  assert.equal(again.action, 'incident_existing');
  assert.equal(again.incidentId, first.incidentId);
  assert.equal((await t.call('GET', '/me/incidents/active', { token })).json.incident, null);

  // 다른 보고면 새 사고
  assert.equal((await send({ indicators: CRASH, reportId: 'ses1:ev9' })).json.action, 'incident_created');
});

test('정상 주행 지표는 기각하고 기록만 남긴다', async () => {
  const t = await setup();
  const { send } = await pairedBackend(t);
  const res = (await send({ indicators: BUMP, producer: 'mujoco:D6_v09' })).json;
  assert.equal(res.decision, 'reject');
  assert.equal(res.action, 'logged');
  assert.equal(res.incidentId, null);

  const log = (await t.ops('GET', '/judgments')).json.items;
  assert.equal(log.length, 1);
  assert.equal(log[0].producer, 'mujoco:D6_v09');
  assert.equal(log[0].decision, 'reject');
});

test('경보여도 사고를 열지 않는 경우와 그 이유', async () => {
  // Phase 1: 판정만 기록
  let t = await setup({ DETECTION_ENABLED: 'false' });
  let backend = await pairedBackend(t);
  assert.deepEqual(pick((await backend.send({ indicators: CRASH })).json), { decision: 'alarm', action: 'logged', reason: 'detection_disabled' });

  // 운행 중이 아님
  t = await setup();
  backend = await pairedBackend(t, { drive: false });
  assert.deepEqual(pick((await backend.send({ indicators: CRASH })).json), { decision: 'alarm', action: 'logged', reason: 'no_active_session' });

  // 운영 서버에 시뮬레이션 지표 — 합성 값으로 실제 연락처를 깨우지 않는다
  t = await setup({ NODE_ENV: 'production', DETECTION_ENABLED: 'true', OPS_TOKEN: 'x'.repeat(24) });
  backend = await pairedBackend(t);
  assert.deepEqual(pick((await backend.send({ indicators: CRASH, mode: 'simulated' })).json), { decision: 'alarm', action: 'logged', reason: 'not_live' });

  // 페어링 안 된 기기
  t = await setup();
  const reg = (await t.call('POST', '/device-api/register', { body: { name: 'x', kind: 'tag' } })).json;
  const res = await t.call('POST', '/device-api/indicators', { body: { indicators: CRASH }, headers: { authorization: `Device ${reg.deviceToken}` } });
  assert.deepEqual(pick(res.json), { decision: 'alarm', action: 'logged', reason: 'not_paired' });
});

const pick = (r: { decision: string; action: string; reason: string | null }) => ({ decision: r.decision, action: r.action, reason: r.reason });

test('개발 서버의 시뮬레이션 지표는 테스트 사고로 열린다', async () => {
  const t = await setup();
  const { token, send } = await pairedBackend(t);
  const res = (await send({ indicators: indicators({ peak_g: 6, peak_gyro: 200, delta_v150: 1, bank_deg: 85, quiet_s: 25 }), mode: 'simulated' })).json;
  assert.equal(res.action, 'incident_created');
  const incident = (await t.call('GET', `/me/incidents/${res.incidentId}`, { token })).json;
  assert.equal(incident.source, 'test');
  assert.equal(incident.kind, 'fall');
});

test('dryRun 은 판정만 돌려주고 아무것도 남기지 않는다', async () => {
  const t = await setup();
  const { send } = await pairedBackend(t);
  const res = (await send({ indicators: CRASH, dryRun: true })).json;
  assert.deepEqual(pick(res), { decision: 'alarm', action: 'dry_run', reason: null });
  assert.equal((await t.ops('GET', '/judgments')).json.items.length, 0);
  assert.equal((await t.ops('GET', '/incidents')).json.items.length, 0);
});

test('moto-sensing Snapshot 을 그대로 보내도 읽는다 (모르는 필드는 버림)', async () => {
  const t = await setup();
  const { send } = await pairedBackend(t);
  const snapshot = {
    device_id: 'pi5-01',
    session_id: '2026-09-18T22-14-03_pi5-01',
    t: 12.4,
    mode: 'live',
    fused: null,
    indicators: BUMP,
    recent_events: [],
    health: { 'tick.count': 620 },
  };
  const res = await send(snapshot);
  assert.equal(res.status, 200);
  assert.equal(res.json.decision, 'reject');
});

test('휴대폰 중계 경로(태그 → BLE → 폰 → 서버)도 같은 판정을 쓴다', async () => {
  const t = await setup();
  const { token } = await pairedBackend(t);
  const res = (await t.call('POST', '/me/indicators', { token, body: { indicators: CRASH } })).json;
  assert.equal(res.action, 'incident_created');
  assert.equal((await t.call('GET', `/me/incidents/${res.incidentId}`, { token })).json.source, 'tag');
});

test('지표 형식이 틀리면 400 과 이유', async () => {
  const t = await setup();
  const { send } = await pairedBackend(t);
  const res = await send({ indicators: [{ key: 'peak_g', value: '7', unit: 'g', state: 'ok', sqi: null, t: 1 }] });
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /indicators\.0\.value/);
});
