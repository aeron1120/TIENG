import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebAlarm } from '../src/features/web-alarm.ts';

function audio() {
  const tones: { stopped: boolean; disconnected: boolean }[] = [];
  let tick: (() => void) | null = null;
  const ctx = {
    state: 'suspended', currentTime: 0, destination: {}, onstatechange: null as (() => void) | null,
    async resume() { this.state = 'running'; },
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; },
    createOscillator() {
      const tone = { stopped: false, disconnected: false }; tones.push(tone);
      return { frequency: { value: 0 }, type: 'sine', connect() {}, start() {}, stop(at?: number) { if (at === undefined) tone.stopped = true; }, disconnect() { tone.disconnected = true; }, onended: null };
    },
  };
  const alarm = new WebAlarm(() => ctx as unknown as AudioContext, { every(fn) { tick = fn; return 1; }, cancel() { tick = null; } });
  return { alarm, ctx, tones, tick: () => tick?.(), hasTick: () => tick !== null };
}

test('unprepared or unavailable audio does not claim it can play', async () => {
  const alarm = new WebAlarm(() => null);
  assert.equal(alarm.start(), false);
  assert.equal(await alarm.prepare(false), false);
  assert.equal(alarm.getState(), 'unavailable');
});

test('user preparation enables recurring alarm; stop disconnects every scheduled tone', async () => {
  const { alarm, tones, hasTick, tick } = audio();
  assert.equal(await alarm.prepare(false), true);
  assert.equal(alarm.getState(), 'ready');
  assert.equal(alarm.start(), true);
  assert.equal(alarm.getState(), 'playing');
  assert.equal(hasTick(), true);
  tick();
  assert.ok(tones.length >= 4);
  alarm.stop();
  assert.equal(hasTick(), false);
  assert.ok(tones.every(t => t.stopped && t.disconnected));
  assert.equal(alarm.getState(), 'ready');
  alarm.disable();
  assert.equal(alarm.start(), false);
  assert.equal(alarm.getState(), 'off');
});

test('browser refusal and interruption are shown instead of a ready status', async () => {
  const { alarm, ctx, hasTick } = audio();
  ctx.resume = async () => { throw new Error('NotAllowedError'); };
  assert.equal(await alarm.prepare(false), false);
  assert.equal(alarm.getState(), 'blocked');
  ctx.resume = async () => { ctx.state = 'running'; };
  assert.equal(await alarm.prepare(false), true);
  alarm.start();
  ctx.state = 'suspended'; ctx.onstatechange?.();
  assert.equal(alarm.getState(), 'blocked');
  assert.equal(hasTick(), false);
});

test('leaving during a pending resume cannot play a delayed test sound', async () => {
  const { alarm, ctx, tones } = audio();
  let complete!: () => void;
  ctx.resume = () => new Promise<void>(resolve => { complete = () => { ctx.state = 'running'; resolve(); }; });
  const preparation = alarm.prepare(true);
  alarm.stop();
  complete();
  assert.equal(await preparation, false);
  assert.equal(tones.length, 0);
  assert.notEqual(alarm.getState(), 'playing');
});
