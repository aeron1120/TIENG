import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decimate, splitSegments, wavePaths, yMaxFor, type WavePoint } from '../src/lib/waveform.ts';

const p = (t: number, accG: number | null, extra: Partial<WavePoint> = {}): WavePoint => ({ t, accG, gyroDps: 0, bankDeg: -50, dv150: null, gap: false, saturated: false, ...extra });

test('결측·누락·역행에서 선을 끊고 보간하지 않는다', () => {
  const segs = splitSegments([p(0, 1), p(0.1, 2), p(0.2, null), p(0.3, 3), p(0.4, 4, { gap: true }), p(0.35, 5), p(0.5, 6)], 'accG');
  assert.deepEqual(segs.map((s) => s.map((x) => x.t)), [[0, 0.1], [0.3], [0.4], [0.5]]);
});

test('뱅크각은 크기로 그리고 dv150 결측은 선이 없다', () => {
  assert.equal(splitSegments([p(0, 1)], 'bankDeg')[0]![0]!.v, 50);
  assert.deepEqual(splitSegments([p(0, 1), p(0.1, 1)], 'dv150'), []);
});

test('축약해도 피크 표본은 남는다', () => {
  const seg = Array.from({ length: 10_000 }, (_, i) => ({ t: i / 1000, v: i === 4321 ? 42 : Math.sin(i) }));
  const out = decimate(seg, { width: 100, height: 50, t0: 0, t1: 10, yMax: 50 });
  assert.ok(out.length <= 200);
  assert.ok(out.some((x) => x.t === 4.321 && x.v === 42));
  assert.ok(out.every((x, i) => i === 0 || x.t >= out[i - 1]!.t));
});

test('세로 범위는 임계선과 피크를 모두 포함한다', () => {
  assert.equal(yMaxFor([p(0, 1)], 'accG', 6), 7.5);
  assert.equal(yMaxFor([p(0, 20)], 'accG', 6), 21);
  assert.equal(wavePaths([p(0, 1), p(1, 1)], 'accG', { width: 100, height: 10, t0: 0, t1: 1, yMax: 2 })[0], 'M0.0 5.0L100.0 5.0');
});
