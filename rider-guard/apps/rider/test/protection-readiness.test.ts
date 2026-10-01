import assert from 'node:assert/strict';
import { test } from 'node:test';

import { protectionReadiness } from '../src/features/protection-readiness.ts';

const now = Date.parse('2026-10-01T12:00:00Z');
const input = { sessionActive: true, device: { kind: 'helmet_tag', sensorState: 'fresh' as const, lastSensorAt: new Date(now - 10_000).toISOString(), staleAfterSeconds: 60 }, phoneStatus: 'device_paired', locationAt: new Date(now - 20_000).toISOString(), locationPermission: 'foreground', now };

test('fresh helmet and phone sources are distinguished; location age is independently shown', () => {
  const helmet = protectionReadiness(input);
  assert.equal(helmet.sensorFresh, true);
  assert.equal(helmet.source, '헬멧 센서');
  assert.match(helmet.sensorText, /10초/);
  assert.match(helmet.locationText, /20초/);
  const phone = protectionReadiness({ ...input, device: { ...input.device, kind: 'phone' }, phoneStatus: 'running' });
  assert.equal(phone.source, '휴대폰 센서');
  assert.match(phone.detail, /헬멧.*다른/);
});

test('wall clock staleness overrides a previously fresh server response', () => {
  const state = protectionReadiness({ ...input, now: now + 60_000 });
  assert.equal(state.sensorFresh, false);
  assert.match(state.title, /연결 확인/);
  assert.equal(state.action, 'connection');
});

test('a stale phone heartbeat offers server refresh instead of helmet setup', () => {
  const state = protectionReadiness({ ...input, device: { ...input.device, kind: 'phone', sensorState: 'stale', lastSensorAt: new Date(now - 90_000).toISOString() }, phoneStatus: 'running' });
  assert.equal(state.sensorFresh, false);
  assert.equal(state.action, 'refresh');
  assert.match(state.detail, /휴대폰.*서버/);
  assert.doesNotMatch(state.detail, /헬멧 전원/);
});

test('missing, invalid, future and webcam samples cannot indicate protection readiness', () => {
  for (const device of [null, { ...input.device, lastSensorAt: 'invalid' }, { ...input.device, lastSensorAt: new Date(now + 60_000).toISOString() }, { ...input.device, kind: 'webcam-test' }]) {
    assert.equal(protectionReadiness({ ...input, device }).sensorFresh, false);
  }
  assert.equal(protectionReadiness({ ...input, sessionActive: false }).sensorFresh, false);
});

test('permission actions and unknown GPS remain actionable without invented coordinates', () => {
  const state = protectionReadiness({ ...input, device: null, phoneStatus: 'needs_permission', locationAt: null, locationPermission: 'denied' });
  assert.equal(state.action, 'enable_phone');
  assert.match(state.locationText, /권한/);
  assert.match(protectionReadiness({ ...input, device: null, phoneStatus: 'denied' }).detail, /브라우저 설정/);
  assert.match(protectionReadiness({ ...input, locationAt: new Date(now - 300_000).toISOString() }).locationText, /오래된/);
});
