import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PresentationOutbox } from '../src/features/demo/presentation-outbox.ts';

test('수신 응답이 유실돼도 같은 순서 번호로 재전송한다', async () => {
  const q = new PresentationOutbox();
  q.push({ type: 'play', driver: 'a' });
  q.push({ type: 'tick', dt: 0.1 });
  const batch = q.batch();
  assert.deepEqual(q.batch(), batch);
  q.acknowledge(2);
  assert.equal(q.pending, 0);
  assert.equal(q.push({ type: 'pause' }).seq, 3);
});

test('전송 중 들어온 명령은 앞 배치 응답 후에도 남는다', () => {
  const q = new PresentationOutbox();
  q.push({ type: 'play', driver: 'a' });
  q.push({ type: 'tick', dt: 0.1 });
  const batch = q.batch();
  q.push({ type: 'respond', response: 'help' });
  q.acknowledge(batch.at(-1)!.seq);
  assert.deepEqual(q.batch().map((c) => c.action.type), ['respond']);
  assert.throws(() => q.acknowledge(999), /sequence/);
});

test('요청 크기를 제한하고 오래된 응답이 큐를 되돌리지 않는다', () => {
  const q = new PresentationOutbox();
  for (let i = 0; i < 120; i++) q.push({ type: 'tick', dt: 0.1 });
  assert.equal(q.batch().length, 100);
  q.acknowledge(100);
  q.acknowledge(50);
  assert.equal(q.pending, 20);
  assert.equal(q.batch()[0]!.seq, 101);
});
