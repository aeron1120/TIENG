import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initialState, MAIN_RIDER, reduce, type DemoAction, type DemoState, type EventClip } from '../src/features/demo/engine.ts';
import { dispatchPresentationAction, presentationMutationBlock, presentationPlaybackActions, presentationStage } from '../src/features/demo/display.ts';

const collision: EventClip = { caseId: 'A1', from: 0, to: 2, candidateAt: 1, decision: 'candidate' };
const normal: EventClip = { caseId: 'D7', from: 0, to: 2, candidateAt: null, decision: 'no_candidate' };
function advance(seconds: number, clip = collision, state = initialState('full', 0)) {
  let s = reduce(reduce(state, { type: 'slowmo', on: false }), { type: 'play', driver: 'test' });
  for (let n = 0; n < seconds * 10; n++) s = reduce(s, { type: 'tick', dt: 0.1, clip });
  return s;
}

test('incomplete event data does not imply normal driving or completed response', () => {
  const clip: EventClip = { ...normal, decision: 'insufficient' };
  const stage = presentationStage(advance(10, clip), clip);
  assert.equal(stage.key, 'insufficient');
  assert.equal(stage.tone, 'warning');
  assert.match(stage.description, /부족/);
  assert.doesNotMatch(stage.description, /정상으로|구조 완료/);
  assert.deepEqual(stage.skippedSteps, [2, 3, 4]);
});

test('no candidate explains unchanged orders, without confirming absence of an accident', () => {
  const s = advance(10, normal);
  const stage = presentationStage(s, normal);
  assert.equal(stage.key, 'no_candidate');
  assert.match(stage.description, /후보 조건/);
  assert.match(stage.description, /주문/);
  assert.ok(s.orders.every((o) => o.status === 'delivering'));
});

test('candidate waits for rider, then distinguishes no response from help and order handoff', () => {
  const waiting = advance(8);
  assert.equal(presentationStage(waiting, collision).key, 'confirming');
  assert.match(presentationStage(waiting, collision).description, /응답/);
  const timeout = reduce(waiting, { type: 'skipWait' });
  assert.match(presentationStage(timeout, collision).description, /응답이 없어/);
  const help = reduce(waiting, { type: 'respond', response: 'help' });
  assert.match(presentationStage(help, collision).description, /도움을 요청/);
  assert.doesNotMatch(presentationStage(help, collision).description, /응답이 없어/);
  const acknowledged = reduce(timeout, { type: 'ack' });
  assert.equal(presentationStage(acknowledged, collision).key, 'handoff');
  assert.match(presentationStage(acknowledged, collision).description, /보류.*2건/);
});

test('rider cancellation and response closure retain their distinct meaning', () => {
  const waiting = advance(8);
  const cancelled = presentationStage(reduce(waiting, { type: 'respond', response: 'ok' }), collision);
  assert.equal(cancelled.key, 'rider_ok');
  assert.match(cancelled.description, /라이더.*괜찮/);
  assert.match(cancelled.description, /사고 여부.*확정하지/);
  let s: DemoState = reduce(reduce(waiting, { type: 'skipWait' }), { type: 'ack' });
  for (const o of s.orders.filter((o) => o.originalRiderId === MAIN_RIDER)) s = reduce(s, { type: 'reassign', orderId: o.id, riderId: 'r2' });
  s = reduce(s, { type: 'resolve' });
  const closed = presentationStage(s, collision);
  assert.equal(closed.key, 'resolved');
  assert.match(closed.description, /시연.*종결/);
  assert.match(closed.description, /실제 구조 완료.*뜻하지/);
});

test('upcoming verdict is not shown before playback reaches its event', () => {
  const insufficient: EventClip = { ...normal, decision: 'insufficient' };
  assert.equal(presentationStage(initialState(), insufficient).key, 'ready');
  assert.equal(presentationStage(advance(3, insufficient), insufficient).key, 'watching');
});

test('a later sensor disconnection does not rewrite an already completed verdict', () => {
  const judged = advance(10, normal);
  const disconnected = reduce(judged, { type: 'sensor', lost: true });
  assert.equal(presentationStage(disconnected, normal).key, 'no_candidate');
  const missed = advance(10, collision, reduce(initialState(), { type: 'sensor', lost: true }));
  assert.equal(presentationStage(reduce(missed, { type: 'sensor', lost: false }), collision).key, 'insufficient');
});

test('starting after scenario reset applies the selected mode through the full response flow', () => {
  let s = reduce(advance(8), { type: 'reset', scenario: 'stopped', baseWall: 0 });
  s = presentationPlaybackActions(s, true, 'test').reduce(reduce, s);
  s = advance(65, collision, s);
  assert.equal(s.incident?.status, 'resolved');
  assert.equal(s.playing, false);
  const manual = presentationPlaybackActions(reduce(s, { type: 'reset', baseWall: 0 }), false, 'test').reduce(reduce, reduce(s, { type: 'reset', baseWall: 0 }));
  assert.equal(advance(65, collision, manual).incident?.status, 'escalated');
});

test('unrestored and uncertain connections cannot lose rider responses or operations changes locally', () => {
  const waiting = advance(8);
  const active = reduce(reduce(waiting, { type: 'skipWait' }), { type: 'ack' });
  const scenarios: [DemoState, DemoAction][] = [
    [waiting, { type: 'respond', response: 'ok' }],
    [waiting, { type: 'respond', response: 'help' }],
    [active, { type: 'resolve' }],
    [active, { type: 'reassign', orderId: active.orders[0]!.id, riderId: 'r2' }],
  ];
  for (const connection of [
    { status: 'idle', canResume: true },
    ...['connecting', 'restoring', 'retrying', 'error'].map((status) => ({ status, canResume: false })),
  ]) {
    assert.ok(presentationMutationBlock(connection));
    for (const [before, action] of scenarios) {
      let after = before;
      dispatchPresentationAction(connection, action, (next) => { after = reduce(after, next); });
      assert.equal(after, before, `${connection.status}: ${action.type} must await connection`);
    }
  }
  for (const status of ['idle', 'connected', 'sending']) {
    const connection = { status, canResume: false };
    assert.equal(presentationMutationBlock(connection), null);
    let after = waiting;
    dispatchPresentationAction(connection, { type: 'respond', response: 'ok' }, (next) => { after = reduce(after, next); });
    assert.equal(after.incident?.status, 'rider_ok', `${status}: usable local or connected replay`);
  }
});
