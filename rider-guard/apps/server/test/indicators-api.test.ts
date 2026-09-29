import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Indicator } from '@rider-guard/contract';

import { setup } from './helpers.ts';

const indicators = (v: { delta_v: number; tilt_deg: number; speed: number; accel_var_1s: number }): Indicator[] => [
  { key: 'delta_v', value: v.delta_v, unit: 'm/s', state: 'ok', sqi: null, t: 4 },
  { key: 'tilt_deg', value: v.tilt_deg, unit: 'deg', state: 'ok', sqi: null, t: 4 },
  { key: 'speed', value: v.speed, unit: 'm/s', state: 'ok', sqi: null, t: 4 },
  { key: 'accel_var_1s', value: v.accel_var_1s, unit: 'm/s^2', state: 'ok', sqi: null, t: 4 },
];
const CRASH = indicators({ delta_v: 7.4, tilt_deg: 84, speed: 0.1, accel_var_1s: 0.04 });
const BUMP = indicators({ delta_v: 1.3, tilt_deg: 6, speed: 5.4, accel_var_1s: 2.2 });

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

  await t.advance(30); // 무응답 → 비상연락 + 관제
  const detail = (await t.ops('GET', `/incidents/${active.id}`)).json;
  assert.equal(detail.evidence.decision, 'alarm');
  assert.equal(detail.evidence.producer, 'tag-v1');
  assert.equal(detail.evidence.traces.find((x: { rule: string }) => x.rule === 'impact').inputs.delta_v, 7.4);
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
  const res = (await send({ indicators: BUMP, producer: 'mujoco:3_speedbump' })).json;
  assert.equal(res.decision, 'reject');
  assert.equal(res.action, 'logged');
  assert.equal(res.incidentId, null);

  const log = (await t.ops('GET', '/judgments')).json.items;
  assert.equal(log.length, 1);
  assert.equal(log[0].producer, 'mujoco:3_speedbump');
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
  const res = (await send({ indicators: indicators({ delta_v: 2.1, tilt_deg: 88, speed: 0.2, accel_var_1s: 0.05 }), mode: 'simulated' })).json;
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
  const res = await send({ indicators: [{ key: 'delta_v', value: '7', unit: 'm/s', state: 'ok', sqi: null, t: 1 }] });
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /indicators\.0\.value/);
});
