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
const stepKeys = (detail: { steps: { key: string; state: string }[] }) => detail.steps.map((s) => `${s.key}:${s.state}`);
const step = (detail: { steps: { key: string }[] }, key: string) => detail.steps.find((s) => s.key === key) as any;

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
  assert.equal(step(inc, 'emergency').state, 'todo');

  await t.advance(3);
  const ok = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  assert.equal(ok.json.status, 'cancelled');
  assert.equal(ok.json.resolution, 'false_alarm');

  await t.advance(120);
  assert.equal(contactSms(t).length, 0);
  assert.equal(t.reports.length, 0);
  const list = await t.call('GET', '/me/incidents', { token });
  assert.equal(list.json.items[0].responseSeconds, 3);
  assert.equal(list.json.items[0].resolution, 'false_alarm');
});

test('30초 무응답 → 1순위에게 위치 링크 문자, 1분 뒤 2순위, 119 는 바로 자동 신고 (4.3)', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } })).json.incident;

  await t.advance(29);
  assert.equal((await t.call('GET', `/me/incidents/${inc.id}`, { token })).json.status, 'countdown');
  assert.equal(t.reports.length, 0);

  await t.advance(1);
  const escalated = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(escalated.status, 'escalated');
  assert.equal(escalated.escalationReason, 'no_response');
  assert.equal(contactSms(t).length, 1);
  assert.equal(contactSms(t)[0]!.to, '01011111111');
  assert.match(contactSms(t)[0]!.body, /김라이더님에게 사고가 감지됐고 30초 동안 응답이 없었어요\. 현재 위치: https:\/\/rg\.test\/s\/[\w-]{43} 119에도 자동으로 신고해요\./);

  // 상담원 판단을 기다리지 않는다
  assert.equal(t.reports.length, 1);
  assert.match(t.reports[0]!, /사고 자동 신고/);
  assert.match(t.reports[0]!, /위도 37\.566500, 경도 126\.978000/);
  assert.match(t.reports[0]!, /충격 감지 · 30초간 라이더 무응답/);
  assert.match(t.reports[0]!, /라이더: 김라이더 010-1234-5678/);

  const contacts = step(escalated, 'contacts');
  assert.equal(contacts.state, 'done');
  assert.deepEqual(contacts.detail.notified, [{ priority: 1, name: '엄마' }]);
  assert.equal(contacts.detail.pending, 1);
  assert.deepEqual(step(escalated, 'emergency').detail, { delivery: 'sent' });
  assert.deepEqual(stepKeys(escalated), ['detected:done', 'response:done', 'contacts:done', 'emergency:done', 'record:todo']);

  await t.advance(60);
  assert.deepEqual(contactSms(t).map((s) => s.to), ['01011111111', '01022222222']);

  // 늦게라도 '도움 요청'을 누르면 사고는 그대로 두고 119 에 후속 문자 — 두 번 눌러도 한 번만
  const help = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'help' } });
  assert.equal(help.json.status, 'escalated');
  assert.equal(help.json.riderResponse, 'help');
  await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'help' } });
  await t.advance(1);
  assert.equal(t.reports.length, 2);
  assert.match(t.reports[1]!, /앞서 자동 신고한 김라이더 010-1234-5678 사고 건 — 라이더가 앱에서 직접 도움을 요청했어요/);
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
  assert.match(page.text, /119에 자동으로 신고했어요/);
  assert.doesNotMatch(page.text, /관제센터/);
  assert.match(page.text, /37\.566500, 126\.978000/);

  const ack = await t.call('POST', `${link}/ack`);
  assert.equal(ack.status, 303);
  await t.advance(120);
  assert.deepEqual(contactSms(t).map((s) => s.to), ['01011111111']);

  const detail = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(step(detail, 'contacts').detail.acknowledgedBy, '엄마');

  // 위치를 본 기록이 라이더에게 남는다 (9.1 이용내역)
  const access = await t.call('GET', '/me/location-access', { token });
  assert.equal(access.json.items.length, 1);
  assert.equal(access.json.items[0].accessor, '1순위 엄마 (가족)');
});

test('도움 요청 → 즉시 에스컬레이션, 119 자동 신고, 주문 보류 뒤 대체배차 자동 완료', async () => {
  const t = await setup();
  const { token } = await riding(t);
  await t.call('POST', '/me/dev/order', { token, body: { storeName: '행복치킨', destination: '역삼동 12-3' } });
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;

  // 카운트다운 중에는 운영 모니터에 보이지 않는다 (사고 확정 시에만)
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
  assert.equal(t.reports.length, 1);
  assert.match(t.reports[0]!, /충격 감지 · 라이더가 도움 요청/);

  const status = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.deepEqual(stepKeys(status), ['detected:done', 'response:done', 'contacts:done', 'emergency:done', 'order:done', 'record:todo']);
  assert.equal(status.steps[1].detail.seconds, 14);
  assert.equal(status.order.status, 'reassigned');

  // 운영 모니터는 읽기만 한다 — 위치·전화번호·의료정보를 싣지 않고, 상담원이 누르던 동작은 없다
  const list = (await t.ops('GET', '/incidents')).json.items;
  assert.deepEqual(list.map((i: { id: string; status: string }) => [i.id, i.status]), [[inc.id, 'escalated']]);
  const detail = (await t.ops('GET', `/incidents/${inc.id}`)).json;
  assert.equal(detail.emergency, 'sent');
  assert.equal(detail.location, undefined);
  assert.equal(detail.rider.phone, undefined);
  const events = detail.timeline.map((e: { type: string }) => e.type);
  assert.ok(events.includes('emergency_reported') && events.includes('order_reassigned'));
  for (const action of ['claim', 'emergency', 'order-reassigned', 'resolve']) {
    assert.equal((await t.ops('POST', `/incidents/${inc.id}/${action}`, {})).status, 404);
  }
  const access = await t.call('GET', '/me/location-access', { token });
  assert.equal(access.json.items.length, 0);

  // 라이더가 괜찮다고 하거나 24시간이 지날 때까지 열려 있다
  assert.equal((await t.call('GET', '/me/incidents/active', { token })).json.incident.id, inc.id);
});

test('비상연락이 시작된 뒤 괜찮아요 → 사고를 닫고, 이미 알린 연락처와 119 에 무사하다고 알린다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30);
  const ok = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  assert.equal(ok.json.status, 'resolved');
  assert.equal(ok.json.resolution, 'rider_ok');

  await t.advance(120);
  // 2순위 문자는 취소되고, 1순위에게 안심 문자
  const sent = contactSms(t);
  assert.deepEqual(sent.map((s) => s.to), ['01011111111', '01011111111']);
  assert.match(sent[1]!.body, /김라이더님이 괜찮다고 응답해서 사고 대응을 마쳤어요/);
  assert.equal(t.reports.length, 2);
  assert.match(t.reports[1]!, /라이더 본인이 앱에서 '괜찮다'고 응답했어요/);

  const final = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.deepEqual(stepKeys(final), ['detected:done', 'response:done', 'contacts:done', 'emergency:done', 'record:done']);
  assert.equal((await t.call('GET', '/me/incidents/active', { token })).json.incident, null);
  assert.equal((await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } })).status, 409);
});

test('119 신고가 나가기 전에 괜찮아요를 누르면 신고도 문자도 보내지 않는다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'help' } });
  // 스케줄러가 돌기 전 (outbox 에만 있을 때)
  const ok = await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  assert.equal(ok.json.resolution, 'rider_ok');

  await t.advance(120);
  assert.equal(contactSms(t).length, 0);
  assert.equal(t.reports.length, 0);
  const final = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(step(final, 'contacts').state, 'skipped');
  assert.deepEqual(step(final, 'emergency').detail, { delivery: 'cancelled' });
});

test('라이더가 끝내 응답하지 못한 사고는 24시간 뒤 조용히 닫힌다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'fall' } })).json.incident;
  await t.advance(30);
  const escalatedAt = t.now();

  await t.advance(24 * 3600 - 1);
  assert.equal((await t.call('GET', `/me/incidents/${inc.id}`, { token })).json.status, 'escalated');
  const smsBefore = t.sms.length;

  await t.advance(1);
  assert.equal(t.now() - escalatedAt, 24 * 3_600_000);
  const closed = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolution, 'handled');
  await t.advance(60);
  assert.equal(t.sms.length, smsBefore, '하루 뒤 종료 문자는 보내지 않는다');
  assert.equal(t.reports.length, 1);
});

test('119 자동 신고가 계속 실패하면 다시 시도하다가, 문자를 받은 연락처에게 직접 신고를 부탁한다', async () => {
  const t = await setup();
  const { token } = await riding(t);
  t.ctx.providers.emergency.report = async () => {
    throw new Error('회선 오류');
  };
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30); // 1차 실패
  const retrying = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.deepEqual([step(retrying, 'emergency').state, step(retrying, 'emergency').detail.delivery], ['now', 'retrying']);
  const link = contactSms(t)[0]!.body.match(/https:\/\/rg\.test(\/s\/[\w-]+)/)![1]!;
  assert.match((await t.call('GET', link)).text, /119 자동 신고가 늦어지고 있어요/);

  for (let i = 0; i < 10; i++) await t.advance(100); // 10초·20초…90초 간격으로 9번 더 → 실패 확정

  const failed = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(step(failed, 'emergency').detail.delivery, 'failed');
  assert.equal(failed.status, 'escalated');
  assert.ok(contactSms(t).some((s) => s.to === '01011111111' && /119 자동 신고가 전송되지 않았어요/.test(s.body)));
  assert.match((await t.call('GET', link)).text, /지금 119에 신고해 주세요/);
  assert.equal((await t.ops('GET', `/incidents/${inc.id}`)).json.emergency, 'failed');
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

test('비상연락처가 없어도 119 신고는 간다', async () => {
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/session', { token });
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30);
  const detail = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  const contacts = step(detail, 'contacts');
  assert.equal(contacts.state, 'skipped');
  assert.equal(contacts.detail.reason, 'no_contacts');
  assert.equal(step(detail, 'emergency').detail.delivery, 'sent');
  assert.equal(t.reports.length, 1);
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
  const contacts = step((await t.call('GET', `/me/incidents/${inc.id}`, { token })).json, 'contacts');
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

test('운영 모니터는 서버가 개발용 토큰으로 떴을 때만 그 토큰을 미리 채운다', async () => {
  const dev = await setup();
  assert.match((await dev.call('GET', '/ops')).text, /"dev-ops-token"/);

  const configured = await setup({ OPS_TOKEN: 'x'.repeat(32) });
  const page = (await configured.call('GET', '/ops')).text;
  assert.doesNotMatch(page, /dev-ops-token/);
  assert.doesNotMatch(page, /x{32}/);
  assert.equal((await configured.call('GET', '/ops/api/incidents')).status, 401);
});
