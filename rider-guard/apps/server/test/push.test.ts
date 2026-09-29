import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

const TOKEN = 'ExponentPushToken[abc123]';

async function ridingWithPush(t: Awaited<ReturnType<typeof setup>>) {
  const token = await t.login();
  await t.call('POST', '/me/contacts', { token, body: { name: '엄마', relation: 'family', phone: '01011111111' } });
  const reg = await t.call('PUT', '/me/push-token', { token, body: { token: TOKEN, platform: 'android' } });
  assert.equal(reg.status, 204);
  await t.call('POST', '/me/session', { token });
  return token;
}

test('사고가 열리면 라이더 폰에 "괜찮으신가요?" 푸시 — 버튼 카테고리·고우선 채널', async () => {
  const t = await setup();
  const token = await ridingWithPush(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'fall' } })).json.incident;
  await t.advance(0);

  assert.equal(t.pushes.length, 1);
  const [push] = t.pushes;
  assert.equal(push!.to, TOKEN);
  assert.equal(push!.title, '넘어짐이 감지됐어요');
  assert.match(push!.body, /30초 안에 응답이 없으면/);
  assert.deepEqual(push!.data, { type: 'incident', incidentId: inc.id });
  assert.equal(push!.priority, 'high');
  assert.equal(push!.channelId, 'incident');
  assert.equal(push!.categoryId, 'incident');

  const timeline = (await t.call('GET', `/me/incidents/${inc.id}`, { token })).json;
  assert.equal(timeline.status, 'countdown');
});

test('무응답으로 비상연락이 시작되면 한 번 더 알린다, 도움 요청이면 알리지 않는다', async () => {
  const t = await setup();
  const token = await ridingWithPush(t);
  await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } });
  await t.advance(1); // 스케줄러는 1초마다 돈다
  await t.advance(29);
  assert.deepEqual(t.pushes.map((p) => p.title), ['강한 충격이 감지됐어요', '비상연락을 시작했어요']);
  assert.equal(t.pushes[1]!.data.type, 'status');

  const t2 = await setup();
  const token2 = await ridingWithPush(t2);
  const inc = (await t2.call('POST', '/me/incidents', { token: token2, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t2.call('POST', `/me/incidents/${inc.id}/respond`, { token: token2, body: { response: 'help' } });
  await t2.advance(1);
  // 감지 푸시는 이미 응답해서 건너뛰고, 도움 요청 에스컬레이션은 알리지 않는다
  assert.equal(t2.pushes.length, 0);
});

test('앱에서 먼저 응답했으면 늦게 도는 감지 푸시는 보내지 않는다', async () => {
  const t = await setup();
  const token = await ridingWithPush(t);
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  await t.advance(1);
  assert.equal(t.pushes.length, 0);
});

test('지워진 앱의 토큰(DeviceNotRegistered)은 버린다', async () => {
  const t = await setup();
  const token = await ridingWithPush(t);
  t.setPushTicket(() => ({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }));
  await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } });
  await t.advance(0);
  const left = await t.ctx.db.all('SELECT * FROM pushTokens');
  assert.equal(left.length, 0);
});

test('Expo 가 응답하지 않으면 5초 간격으로 다시 시도한다', async () => {
  const t = await setup();
  const token = await ridingWithPush(t);
  let calls = 0;
  const real = t.ctx.providers.push.send;
  t.ctx.providers.push.send = async (m) => {
    calls++;
    if (calls === 1) throw new Error('503');
    return real(m);
  };
  await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } });
  await t.advance(0);
  assert.equal(t.pushes.length, 0);
  await t.advance(5);
  assert.equal(t.pushes.length, 1);
});

test('토큰 등록: 형식 검사, 같은 폰에 다른 라이더가 로그인하면 넘어가고, 로그아웃 때 지운다', async () => {
  const t = await setup();
  const a = await t.login('010-1111-0000');
  assert.equal((await t.call('PUT', '/me/push-token', { token: a, body: { token: 'not-a-token', platform: 'ios' } })).status, 400);
  await t.call('PUT', '/me/push-token', { token: a, body: { token: TOKEN, platform: 'ios' } });

  const b = await t.login('010-2222-0000');
  await t.call('PUT', '/me/push-token', { token: b, body: { token: TOKEN, platform: 'ios' } });
  const rows = await t.ctx.db.all<{ riderId: string }>('SELECT riderId FROM pushTokens');
  assert.equal(rows.length, 1);
  const riderB = (await t.call('GET', '/me', { token: b })).json.rider.id;
  assert.equal(rows[0]!.riderId, riderB);

  await t.call('DELETE', `/me/push-token/${encodeURIComponent(TOKEN)}`, { token: b });
  assert.equal((await t.ctx.db.all('SELECT * FROM pushTokens')).length, 0);
});

test('토큰이 없으면 푸시 없이 문자·119 신고는 그대로 진행된다', async () => {
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/contacts', { token, body: { name: '엄마', relation: 'family', phone: '01011111111' } });
  await t.call('POST', '/me/session', { token });
  await t.call('POST', '/me/incidents', { token, body: { source: 'tag', kind: 'impact' } });
  await t.advance(30);
  assert.equal(t.pushes.length, 0);
  assert.ok(t.sms.some((s) => s.to === '01011111111'));
  assert.equal(t.reports.length, 1);
});
