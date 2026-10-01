import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeOrders,
  candidateDemoT,
  initialState,
  LEAD_IN_S,
  MAIN_RIDER,
  reduce,
  RESPONSE_WAIT_S,
  riderStatus,
  type DemoAction,
  type DemoState,
  type EventClip,
} from '../src/features/demo/engine.ts';

const A1: EventClip = { caseId: 'A1', from: 0.581, to: 2.081, candidateAt: 1.551 };
const D6: EventClip = { caseId: 'D6', from: 1.5, to: 3.0, candidateAt: null };

const run = (s: DemoState, ...actions: DemoAction[]) => actions.reduce(reduce, s);
/** 0.1초씩 dt 만큼 재생 */
const play = (s: DemoState, seconds: number, clip: EventClip) => {
  let out = s;
  for (let i = 0; i < Math.round(seconds * 10); i++) out = reduce(out, { type: 'tick', dt: 0.1, clip });
  return out;
};
const main = (s: DemoState) => riderStatus(s, s.riders.find((r) => r.id === MAIN_RIDER)!);

test('발표 자동 진행은 감지·대기·연락·주문 대체·보고서까지 끝낸 뒤 멈춘다', () => {
  let s = run(initialState('full', 0), { type: 'autopilot', on: true }, { type: 'slowmo', on: false }, { type: 'play', driver: 'presenter' });
  s = play(s, 65, A1);
  assert.equal(s.incident?.status, 'resolved');
  assert.equal(s.incident?.response, 'timeout');
  assert.equal(s.orders.filter((o) => o.originalRiderId === MAIN_RIDER && o.status === 'reassigned').length, 2);
  assert.ok(s.log.some((e) => e.text.includes('119') && e.text.includes('시연')));
  assert.equal(s.playing, false);
});

test('자동 진행도 정상 데이터·센서 끊김을 사고로 만들지 않는다', () => {
  for (const [clip, lost] of [[D6, false], [A1, true]] as const) {
    const s = play(run(initialState('full', 0), { type: 'autopilot', on: true }, { type: 'slowmo', on: false }, { type: 'sensor', lost }, { type: 'play', driver: 'presenter' }), 65, clip);
    assert.equal(s.incident, null);
    assert.equal(s.playing, false);
    assert.ok(s.orders.every((o) => o.status === 'delivering'));
  }
});

test('자동 진행 중 괜찮아요 응답을 하면 연락·주문 보류 없이 끝난다', () => {
  let s = play(run(initialState('full', 0), { type: 'autopilot', on: true }, { type: 'slowmo', on: false }, { type: 'play', driver: 'presenter' }), 8, A1);
  s = play(reduce(s, { type: 'respond', response: 'ok' }), 40, A1);
  assert.equal(s.incident?.status, 'rider_ok');
  assert.equal(s.playing, false);
  assert.equal(s.incident?.contactNotifiedT, null);
});

test('후보가 없어도 데이터가 부족하면 정상으로 단정하지 않는다', () => {
  const clip: EventClip = { ...D6, decision: 'insufficient' };
  const s = play(run(initialState('curb', 0), { type: 'autopilot', on: true }, { type: 'play', driver: 'a' }), 30, clip);
  assert.equal(s.incident, null);
  assert.equal(s.playing, false);
  assert.ok(s.log.some((e) => e.text.includes('판정 불가')));
  assert.ok(!s.log.some((e) => e.text.includes('미충족')));
});

test('정상 주행 중에는 보호 중·배달 중, 사건 없음', () => {
  const s = play(run(initialState('full', 0), { type: 'play', driver: 'a' }), 3, A1);
  assert.equal(s.incident, null);
  assert.equal(main(s), 'delivering');
  assert.ok(s.t > 2.9 && s.t < 3.1);
});

test('파형의 후보 시각에 정확히 확인 요청이 뜨고, 사건 구간은 느리게 흐른다', () => {
  let s = run(initialState('full', 0), { type: 'play', driver: 'a' });
  s = play(s, LEAD_IN_S + 2, A1);
  assert.ok(s.t < LEAD_IN_S + 1, '느린 재생이면 2초 동안 시연 시계는 0.4초만 간다');
  s = play(s, 6, A1);
  assert.equal(s.incident?.status, 'confirming');
  assert.equal(s.incident?.detectedT, candidateDemoT(A1));
  assert.equal(s.incident?.candidateClipT, 1.551);
  assert.equal(main(s), 'check');
});

test('"괜찮아요" → 기록하고 감시 복귀, 주문은 그대로', () => {
  let s = play(run(initialState('full', 0), { type: 'play', driver: 'a' }, { type: 'slowmo', on: false }), LEAD_IN_S + 1.2, A1);
  s = reduce(s, { type: 'respond', response: 'ok' });
  assert.equal(s.incident?.status, 'rider_ok');
  assert.equal(main(s), 'delivering');
  assert.ok(s.orders.filter((o) => o.riderId === MAIN_RIDER).every((o) => o.status === 'delivering'));
  // 두 번 눌러도 한 번만
  assert.equal(reduce(s, { type: 'respond', response: 'help' }), s);
});

test('응답이 없으면 30초 뒤 관제 접수·주문 보류 → 관제 접수·대체 배차·종결이 양쪽에 반영된다', () => {
  let s = play(run(initialState('full', 0), { type: 'play', driver: 'a' }, { type: 'slowmo', on: false }), LEAD_IN_S + 1.2, A1);
  const detected = s.incident!.detectedT;
  s = play(s, RESPONSE_WAIT_S + 0.5, A1);
  assert.equal(s.incident?.status, 'escalated');
  assert.equal(s.incident?.response, 'timeout');
  assert.ok(Math.abs(s.incident!.escalatedT! - (detected + RESPONSE_WAIT_S)) < 0.11);
  assert.equal(main(s), 'incident');
  const held = s.orders.filter((o) => o.status === 'held');
  assert.equal(held.length, 2);
  assert.ok(held.every((o) => o.holdReason === '라이더 사고 대응'));

  s = reduce(s, { type: 'ack' });
  assert.equal(s.incident?.status, 'acknowledged');
  assert.equal(s.incident?.assignee, '관제 박지훈');

  s = run(s, { type: 'reassign', orderId: held[0]!.id, riderId: 'r2' }, { type: 'reassign', orderId: held[1]!.id, riderId: 'r4' });
  const o = s.orders.find((x) => x.id === held[0]!.id)!;
  assert.equal(o.riderId, 'r2');
  assert.equal(o.status, 'reassigned');
  assert.deepEqual(o.notices.map((n) => n.to), ['가게', '라이더', '가게', '고객']);
  assert.equal(riderStatus(s, s.riders.find((r) => r.id === 'r2')!), 'delivering');
  assert.equal(activeOrders(s, MAIN_RIDER).length, 0);

  s = reduce(s, { type: 'resolve' });
  assert.equal(s.incident?.status, 'resolved');
  assert.equal(main(s), 'idle');
  assert.ok(s.log.some((l) => l.text.includes('사건 보고서')));
});

test('"도움이 필요해요"는 기다리지 않고 바로 관제에 접수된다', () => {
  let s = play(run(initialState('full', 0), { type: 'play', driver: 'a' }, { type: 'slowmo', on: false }), LEAD_IN_S + 1.2, A1);
  s = reduce(s, { type: 'respond', response: 'help' });
  assert.equal(s.incident?.status, 'escalated');
  assert.equal(s.incident?.response, 'help');
  assert.ok(s.orders.some((o) => o.status === 'held'));
});

test('D6 연석은 사건 구간을 지나도 후보가 없고 감시를 계속한다', () => {
  const s = play(run(initialState('curb', 0), { type: 'play', driver: 'a' }, { type: 'slowmo', on: false }), LEAD_IN_S + 3, D6);
  assert.equal(s.incident, null);
  assert.equal(s.clipDone, true);
  assert.ok(s.log.some((l) => l.text.includes('후보 아님')));
});

test('센서가 끊긴 채 사건 구간을 지나면 감지하지 못한 것을 그대로 남긴다', () => {
  let s = run(initialState('full', 0), { type: 'play', driver: 'a' }, { type: 'slowmo', on: false });
  s = play(s, 2, A1);
  s = reduce(s, { type: 'sensor', lost: true });
  s = play(s, LEAD_IN_S, A1);
  assert.equal(s.incident, null);
  assert.equal(main(s), 'check');
  assert.ok(s.log.some((l) => l.text.includes('판정하지 못했어요')));
});

test('멈춘 동안은 시계가 가지 않고, 초기화하면 처음 상태로', () => {
  let s = play(run(initialState('full', 0), { type: 'play', driver: 'a' }), 1, A1);
  s = reduce(s, { type: 'pause' });
  const t = s.t;
  assert.equal(play(s, 5, A1).t, t);
  s = reduce(s, { type: 'reset', baseWall: 1 });
  assert.equal(s.t, 0);
  assert.equal(s.playing, false);
  assert.ok(s.v > 0, '초기화도 새 버전이라 다른 탭이 따라온다');
});
