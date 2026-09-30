import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SensorSample } from '@rider-guard/contract';

import { setup } from './helpers.ts';

/** 휴대폰 가속도계·자이로 60Hz 표본 — at 초에 충격(peakG)과 회전(peakDps) */
function phoneSamples(peakG: number, peakDps: number, at = 0.8): SensorSample[] {
  const out: SensorSample[] = [];
  for (let i = 0; i <= 90; i++) {
    const t = Math.round((0.2 + i / 60) * 1000) / 1000;
    const near = Math.abs(t - at) < 0.02;
    out.push({ t, seq: i, accG: near ? peakG : 1, gyroDps: near ? peakDps : 5, bankDeg: null, dv150: null, dvValid: false, dvInvalidReason: 'phone_no_orientation' });
  }
  return out;
}
const metadata = { dataSource: 'measured' as const, sampleRateHz: null, mount: 'phone', provenance: 'test' };

test('휴대폰 센서: 운행 중 표본이 들어오면 휴대폰이 감지 기기가 되고 센서 수신으로 친다', async () => {
  const t = await setup();
  const token = await t.login();
  // 운행 전에는 기기만 만들고 센서 수신으로 치지 않는다
  const before = await t.call('PUT', '/me/phone-sensor', { token, body: { samples: 120, sampleRateHz: 60 } });
  assert.equal(before.status, 200);
  assert.equal(before.json.kind, 'phone');
  assert.equal(before.json.sensorState, 'waiting');

  await t.call('POST', '/me/session', { token });
  // 표본 0 이면 센서가 멈춘 것 — 여전히 대기
  assert.equal((await t.call('PUT', '/me/phone-sensor', { token, body: { samples: 0 } })).json.sensorState, 'waiting');
  const on = await t.call('PUT', '/me/phone-sensor', { token, body: { samples: 900, sampleRateHz: 60 } });
  assert.equal(on.json.sensorState, 'fresh');
  const me = (await t.call('GET', '/me', { token })).json;
  assert.equal(me.device.kind, 'phone');
  assert.equal(me.device.sensorState, 'fresh');
  // 같은 기기를 다시 쓴다
  assert.equal((await t.call('PUT', '/me/phone-sensor', { token, body: { samples: 900 } })).json.id, on.json.id);
});

test('휴대폰 센서: 충격 구간을 같은 규칙으로 판정해 휴대폰 출처 사고를 연다, 약한 흔들림은 열지 않는다', async () => {
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/session', { token });
  await t.call('PUT', '/me/phone-sensor', { token, body: { samples: 600, sampleRateHz: 60 } });

  const weak = await t.call('POST', '/me/indicators', { token, body: { mode: 'live', producer: 'phone-imu', reportId: 'weak', samples: phoneSamples(4.5, 400), sensorMetadata: metadata } });
  assert.equal(weak.status, 200);
  assert.equal(weak.json.incidentId, null);

  const hit = await t.call('POST', '/me/indicators', { token, body: { mode: 'live', producer: 'phone-imu', reportId: 'hit', samples: phoneSamples(7.5, 420), sensorMetadata: metadata } });
  assert.equal(hit.json.decision, 'alarm');
  assert.equal(hit.json.action, 'incident_created');
  const detail = (await t.call('GET', `/me/incidents/${hit.json.incidentId}`, { token })).json;
  assert.equal(detail.source, 'phone');
  assert.equal(detail.dataSource, 'measured');
});

test('휴대폰 센서: 헬멧 기기가 연결돼 있으면 덮어쓰지 않는다', async () => {
  const t = await setup();
  const token = await t.login();
  const reg = await t.call('POST', '/device-api/register', { body: { name: '헬멧 태그', kind: 'tag' } });
  await t.call('POST', '/me/device', { token, body: { pairingCode: reg.json.pairingCode } });
  const r = await t.call('PUT', '/me/phone-sensor', { token, body: { samples: 10 } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'device_paired');
});
