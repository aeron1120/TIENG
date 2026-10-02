import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentationHome } from '../src/features/demo/home-data.ts';
import { protectionReadiness } from '../src/features/protection-readiness.ts';

test('hardware-free presentation stays fresh over a long rehearsal', () => {
  const started = Date.parse('2026-10-02T10:00:00Z');
  const now = started + 3_600_000;
  const me = presentationHome(now, started, true);
  const readiness = protectionReadiness({ sessionActive: !!me.session, device: me.device, phoneStatus: 'idle', locationAt: me.lastLocation?.recordedAt, now });
  assert.equal(readiness.sensorFresh, true);
  assert.equal(readiness.source, '헬멧 센서');
  assert.equal(readiness.sensorText, '2초 전');
  assert.equal(me.session?.startedAt, '2026-10-02T10:00:00.000Z');
  assert.equal(me.affiliation?.orders.length, 1);
});

test('taking off the presentation helmet stops protection without mutating earlier data', () => {
  const now = Date.parse('2026-10-02T10:20:00Z');
  const on = presentationHome(now, now - 60_000, true);
  const off = presentationHome(now, now - 60_000, false);
  assert.equal(off.session, null);
  assert.equal(off.device?.sensorState, 'waiting');
  assert.ok(on.session);
  assert.equal(on.device?.sensorState, 'fresh');
});
