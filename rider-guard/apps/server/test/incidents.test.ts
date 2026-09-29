import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

/** 로그인 + 비상연락처 2명 + 운행 시작 + 위치 1점 */
async function riding(t: Awaited<ReturnType<typeof setup>>) {
  const token = await t.login();
  await t.call('PATCH', '/me', { token, body: { name: '김라이더' } });
  await t.call('POST', '/me/contacts', { token, body: { name: '엄마', relation: 'family', phone: '010-1111-1111' } });
  await t.call('POST', '/me/contacts', { token, body: { name: '박동료', relation: 'coworker', phone: '010-2222-2222' } });
  const session = await t.call('POST', '/me/session', { token });
  await t.call('POST', `/me/sessions/${session.json.id}/locations`, {
    token,
    body: { points: [{ recordedAt: new Date(t.now()).toISOString(), lat: 37.5665, lng: 126.978, accuracy: 8 }] },
  });
  t.sms.length = 0; // 인증번호 문자 제외
  return { token, sessionId: session.json.id as string };
}

const contactSms = (t: Awaited<ReturnType<typeof setup>>) => t.sms.filter((s) => s.to === '01011111111' || s.to === '01022222222');

test('운행 중이 아니면 사고 감지와 위치 수집을 받지 않는다 (2.1, 9.4)', async () => {
  const t = await setup();
  const token = await t.login();
  const incident = await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } });
  assert.equal(incident.status, 409);
  assert.equal(incident.json.error.code, 'no_active_session');

  const session = await t.call('POST', '/me/session', { token });
  await t.call('POST', '/me/session/end', { token });
  await t.advance(300);
  // 끝난 세션에 세션 이후 시각(시계 오차 허용 60초 밖)의 점을 올리면 버린다.
  const late = await t.call('POST', `/me/sessions/${session.json.id}/locations`, {
    token,
    body: { points: [{ recordedAt: new Date(t.now()).toISOString(), lat: 37.5, lng: 127 }] },
  });
  assert.deepEqual(late.json, { accepted: 0, rejected: 1 });
});

test('통신 음영 동안 쌓인 위치는 세션 기간 안이면 나중에 받아 준다 (4.1.4)', async () => {
  const t = await setup();
  const token = await t.login();
  const session = await t.call('POST', '/me/session', { token });
  const during = new Date(t.now() + 10_000).toISOString();
  await t.advance(120);
  await t.call('POST', '/me/session/end', { token });
  await t.advance(600);
  const res = await t.call('POST', `/me/sessions/${session.json.id}/locations`, { token, body: { points: [{ recordedAt: during, lat: 37.5, lng: 127 }] } });
  assert.deepEqual(res.json, { accepted: 1, rejected: 0 });
});

test('괜찮아요 → 오탐으로 기록되고 아무에게도 연락하지 않는다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const created = await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } });
  assert.equal(created.status, 201);
  const inc = created.json.incident;
  assert.equal(inc.status, 'countdown');
  assert.equal(Date.parse(inc.deadlineAt) - t.now(), 30_000);
  assert.deepEqual(inc.location && [inc.location.lat, inc.location.lng], [37.5665, 126.978]);

  await t.advance(3);
  const ok = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  assert.equal(ok.json.status, 'cancelled');
  assert.equal(ok.json.resolution, 'false_alarm');

  await t.advance(120);
  assert.equal(contactSms(t).length, 0);
  const list = await t.call('GET', '/me/incidents', { token });
  assert.equal(list.json.items[0].responseSeconds, 3);
  assert.equal(list.json.items[0].resolution, 'false_alarm');
});

test('30초 무응답 → 1순위에게 위치 링크 문자, 1분 뒤 2순위 (4.3 2단계)', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } })).json.incident;

  await t.advance(29);
  assert.equal((await t.call('GET', `/me/incidents/${inc.id}`, { token })).json.status, 'countdown');

  await t.advance(1);
  const escalated = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(escalated.status, 'escalated');
  assert.equal(escalated.escalationReason, 'no_response');
  assert.equal(contactSms(t).length, 1);
  assert.equal(contactSms(t)[0]!.to, '01011111111');
  assert.match(contactSms(t)[0]!.body, /김라이더님에게 사고가 감지됐고 30초 동안 응답이 없었어요\. 현재 위치: https:\/\/rg\.test\/s\/[\w-]{43} /);

  const contacts = escalated.steps.find((s: { key: string }) => s.key === 'contacts');
  assert.equal(contacts.state, 'done');
  assert.deepEqual(contacts.detail.notified, [{ priority: 1, name: '엄마' }]);
  assert.equal(contacts.detail.pending, 1);

  await t.advance(60);
  assert.deepEqual(contactSms(t).map((s) => s.to), ['01011111111', '01022222222']);

  // 늦게라도 '도움 요청'을 누르면 급함 표시만 붙고 상태는 유지
  const help = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'help' } });
  assert.equal(help.json.status, 'escalated');
});

test('1순위가 링크에서 확인을 누르면 2순위에게는 보내지 않는다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30);
  const link = contactSms(t)[0]!.body.match(/https:\/\/rg\.test(\/s\/[\w-]+)/)![1]!;

  const page = await t.call('GET', link);
  assert.equal(page.status, 200);
  assert.match(page.text, /김라이더님에게 사고가 감지됐어요/);
  assert.match(page.text, /37\.566500, 126\.978000/);

  const ack = await t.call('POST', `${link}/ack`);
  assert.equal(ack.status, 303);
  await t.advance(120);
  assert.deepEqual(contactSms(t).map((s) => s.to), ['01011111111']);

  const steps = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json.steps;
  assert.equal(steps.find((s: { key: string }) => s.key === 'contacts').detail.acknowledgedBy, '엄마');

  // 위치를 본 기록이 라이더에게 남는다 (9.1 이용내역)
  const access = await t.call('GET', '/me/location-access', { token });
  assert.equal(access.json.items.length, 1);
  assert.equal(access.json.items[0].accessor, '1순위 엄마 (가족)');
});

test('도움 요청 → 즉시 에스컬레이션, 주문 보류·대체배차 요청, 관제 확인 후 종료', async () => {
  const t = await setup();
  const { token } = await riding(t);
  await t.call('POST', '/me/dev/order', { token, body: { storeName: '행복치킨', destination: '역삼동 12-3' } });
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;

  // 카운트다운 중에는 관제에 보이지 않는다 (사고 확정 시에만)
  assert.equal((await t.ops('GET', '/incidents')).json.items.length, 0);
  assert.equal((await t.ops('GET', `/incidents/${inc.id}`)).status, 404);

  await t.advance(14);
  const help = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'help' } });
  assert.equal(help.json.status, 'escalated');
  assert.equal(help.json.escalationReason, 'rider_requested');
  assert.equal(help.json.order.status, 'held');

  await t.advance(1);
  assert.match(contactSms(t)[0]!.body, /김라이더님이 사고 후 도움을 요청했어요/);
  assert.equal(t.reassigned.length, 1);

  const list = await t.ops('GET', '/incidents');
  assert.equal(list.json.items[0].urgent, true);

  // 배정 전에는 119 신고 불가
  assert.equal((await t.ops('POST', `/incidents/${inc.id}/emergency`)).status, 409);
  const claimed = await t.ops('POST', `/incidents/${inc.id}/claim`);
  assert.equal(claimed.json.status, 'reviewing');
  assert.equal((await t.ops('POST', `/incidents/${inc.id}/claim`, undefined, '다른상담원')).status, 409);

  // 119 자동 문자는 기본 꺼짐(Phase 2) — 신고문만 받는다
  const emergency = await t.ops('POST', `/incidents/${inc.id}/emergency`);
  assert.equal(emergency.json.mode, 'manual');
  assert.match(emergency.json.report, /위도 37\.566500, 경도 126\.978000/);
  assert.match(emergency.json.report, /라이더가 도움 요청/);
  assert.equal(t.reports.length, 0);

  const status = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  const keys = status.steps.map((s: { key: string; state: string }) => `${s.key}:${s.state}`);
  assert.deepEqual(keys, ['detected:done', 'response:done', 'contacts:done', 'center:now', 'emergency:done', 'order:now', 'record:todo']);
  assert.equal(status.steps[1].detail.seconds, 14);

  await t.ops('POST', `/incidents/${inc.id}/order-reassigned`);
  const resolved = await t.ops('POST', `/incidents/${inc.id}/resolve`, { outcome: 'handled' });
  assert.equal(resolved.json.status, 'resolved');

  await t.advance(1);
  assert.match(contactSms(t).at(-1)!.body, /사고 대응이 종료됐어요/);
  const final = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.deepEqual(
    final.steps.map((s: { key: string; state: string }) => `${s.key}:${s.state}`),
    ['detected:done', 'response:done', 'contacts:done', 'center:done', 'emergency:done', 'order:done', 'record:done'],
  );
  assert.equal((await t.call('GET', '/me/incidents/active', { token })).json.incident, null);
});

test('119 문자 자동 신고를 켜면 상담원 판단으로 실제 발송된다 (Phase 3)', async () => {
  const t = await setup({ ENABLE_119_SMS: 'true' });
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'fall' } })).json.incident;
  await t.advance(30);
  await t.ops('POST', `/incidents/${inc.id}/claim`);
  const res = await t.ops('POST', `/incidents/${inc.id}/emergency`);
  assert.equal(res.json.mode, 'sms');
  assert.equal(t.reports.length, 1);
  assert.match(t.reports[0]!, /전도 감지 · 30초간 라이더 무응답/);
  assert.equal((await t.ops('POST', `/incidents/${inc.id}/emergency`)).status, 409);
});

test('에스컬레이션 후 괜찮아요는 사고를 닫지 않고, 남은 문자를 멈추고 안심 문자를 보낸다 (6.4)', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30);
  const ok = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  assert.equal(ok.json.status, 'escalated');

  await t.advance(120);
  const sent = contactSms(t);
  assert.deepEqual(sent.map((s) => s.to), ['01011111111', '01011111111']);
  assert.match(sent[1]!.body, /괜찮다고 응답했어요/);

  const done = await t.ops('POST', `/incidents/${inc.id}/resolve`, { outcome: 'false_alarm' });
  assert.equal(done.json.resolution, 'false_alarm');
  await t.advance(1);
  assert.match(contactSms(t).at(-1)!.body, /오탐으로 종료됐어요/);
});

test('같은 충격이 반복돼도 진행 중인 사고는 하나다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const a = await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } });
  const b = await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.created, false);
  assert.equal(b.json.incident.id, a.json.incident.id);
});

test('비상연락처가 없어도 관제로는 넘어간다', async () => {
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/session', { token });
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30);
  const detail = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  const contacts = detail.steps.find((s: { key: string }) => s.key === 'contacts');
  assert.equal(contacts.state, 'skipped');
  assert.equal(contacts.detail.reason, 'no_contacts');
  assert.equal((await t.ops('GET', '/incidents')).json.items.length, 1);
});

test('문자 발송이 실패하면 다시 시도하고, 세 번 실패하면 기록한다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  let failing = true;
  const real = t.ctx.providers.sms.send;
  t.ctx.providers.sms.send = async (to, body) => {
    if (failing && to === '01011111111') throw new Error('통신사 오류');
    return real(to, body);
  };
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30); // 1차 실패
  await t.advance(30); // 2차 실패
  await t.advance(60); // 3차 실패 → failed
  const contacts = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json.steps.find((s: { key: string }) => s.key === 'contacts');
  assert.equal(contacts.detail.failed, 1);
  failing = false;
  assert.ok(contactSms(t).some((s) => s.to === '01022222222'), '2순위는 계속 발송된다');
});

test('운행 종료를 잊으면 12시간 뒤 자동 종료된다 (4.1.1)', async () => {
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/session', { token });
  await t.advance(12 * 3600);
  const me = await t.call('GET', '/me', { token });
  assert.equal(me.json.session, null);
  assert.equal(me.json.today.driveSeconds > 0, true);
});
