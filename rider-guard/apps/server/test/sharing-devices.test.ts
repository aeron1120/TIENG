import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

async function withContacts(t: Awaited<ReturnType<typeof setup>>) {
  const token = await t.login();
  const family = (await t.call('POST', '/me/contacts', { token, body: { name: '엄마', relation: 'family', phone: '01011111111' } })).json;
  const coworker = (await t.call('POST', '/me/contacts', { token, body: { name: '박동료', relation: 'coworker', phone: '01022222222' } })).json;
  const other = (await t.call('POST', '/me/contacts', { token, body: { name: '친구', relation: 'other', phone: '01033333333' } })).json;
  const link = async (id: string) => new URL((await t.call('POST', `/me/contacts/${id}/share-link`, { token })).json.url).pathname;
  return { token, family, coworker, other, link };
}

const showsLocation = (html: string) => /37\.500000, 127\.000000/.test(html);

test('관계별 기본 공개 범위: 가족 실시간, 동료 이상 감지 시, 그 외 사고 확정 시 (4.1.2)', async () => {
  const t = await setup();
  const { family, coworker, other } = await withContacts(t);
  assert.equal(family.shareLevel, 'realtime');
  assert.equal(coworker.shareLevel, 'on_anomaly');
  assert.equal(other.shareLevel, 'on_incident');
});

test('상시 링크는 연락처의 공개 범위에 따라 위치를 보여준다', async () => {
  const t = await setup();
  const { token, family, coworker, other, link } = await withContacts(t);
  const [f, c, o] = [await link(family.id), await link(coworker.id), await link(other.id)];
  const html = async (path: string) => (await t.call('GET', path)).text;

  // 운행 전: 아무도 못 본다
  assert.equal(showsLocation(await html(f)), false);

  const session = (await t.call('POST', '/me/session', { token })).json;
  await t.call('POST', `/me/sessions/${session.id}/locations`, {
    token,
    body: { points: [{ recordedAt: new Date(t.now()).toISOString(), lat: 37.5, lng: 127 }] },
  });
  // 운행 중: 가족만
  assert.deepEqual([showsLocation(await html(f)), showsLocation(await html(c)), showsLocation(await html(o))], [true, false, false]);

  // 사고 감지(카운트다운): 가족 + 동료
  await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } });
  assert.deepEqual([showsLocation(await html(f)), showsLocation(await html(c)), showsLocation(await html(o))], [true, true, false]);

  // 사고 확정(무응답 에스컬레이션): 모두
  await t.advance(30);
  assert.deepEqual([showsLocation(await html(f)), showsLocation(await html(c)), showsLocation(await html(o))], [true, true, true]);

  // 운행 종료 후 평상시: 다시 아무도 (사고 종료 후)
  const inc = (await t.call('GET', '/me/incidents/active', { token })).json.incident;
  await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  await t.call('POST', '/me/session/end', { token });
  assert.deepEqual([showsLocation(await html(f)), showsLocation(await html(c)), showsLocation(await html(o))], [false, false, false]);
});

test('사고 문자 링크는 사고가 끝나면 위치를 감추고, 잘못된 토큰은 404', async () => {
  const t = await setup();
  const { token } = await withContacts(t);
  const session = (await t.call('POST', '/me/session', { token })).json;
  await t.call('POST', `/me/sessions/${session.id}/locations`, { token, body: { points: [{ recordedAt: new Date(t.now()).toISOString(), lat: 37.5, lng: 127 }] } });
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;
  await t.advance(30);
  const path = t.sms.find((s) => s.to === '01011111111' && s.body.includes('/s/'))!.body.match(/https:\/\/rg\.test(\/s\/[\w-]+)/)![1]!;
  assert.equal(showsLocation((await t.call('GET', path)).text), true);

  await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  const closed = await t.call('GET', path);
  assert.equal(showsLocation(closed.text), false);
  assert.match(closed.text, /사고 대응이 종료됐어요/);
  assert.match(closed.text, /괜찮다고 응답했어요/);

  assert.equal((await t.call('GET', '/s/not-a-real-token')).status, 404);
});

test('공유 페이지는 이름을 HTML 이스케이프한다', async () => {
  const t = await setup();
  const { token, family, link } = await withContacts(t);
  await t.call('PATCH', '/me', { token, body: { name: '<script>x' } });
  const html = (await t.call('GET', await link(family.id))).text;
  assert.equal(html.includes('<script>x'), false);
  assert.match(html, /&lt;script&gt;x/);
});

test('웹캠 detector: 등록 → 페어링 → 하트비트 → 운행 중 이벤트로 사고 생성', async () => {
  const t = await setup();
  const token = await t.login();
  const reg = await t.call('POST', '/device-api/register', { body: { name: '테스트용 웹캠 detector', kind: 'webcam' } });
  assert.equal(reg.status, 201);
  const device = { authorization: `Device ${reg.json.deviceToken}` };

  const unpaired = await t.call('POST', '/device-api/events', { headers: device, body: { kind: 'fall' } });
  assert.deepEqual(unpaired.json, { status: 'ignored', reason: 'not_paired' });

  const code = reg.json.pairingCode as string;
  const paired = await t.call('POST', '/me/device', { token, body: { pairingCode: `${code.slice(0, 4)} ${code.slice(4)}` } });
  assert.equal(paired.status, 200);
  assert.equal(paired.json.name, '테스트용 웹캠 detector');

  const hb = await t.call('POST', '/device-api/heartbeat', { headers: device, body: { battery: 78 } });
  assert.deepEqual(hb.json, { paired: true, sessionActive: false });
  const me = await t.call('GET', '/me', { token });
  assert.equal(me.json.device.connected, true);
  assert.equal(me.json.device.battery, 78);

  const idle = await t.call('POST', '/device-api/events', { headers: device, body: { kind: 'fall' } });
  assert.deepEqual(idle.json, { status: 'ignored', reason: 'no_active_session' });

  await t.call('POST', '/me/session', { token });
  const created = await t.call('POST', '/device-api/events', { headers: device, body: { kind: 'fall', metrics: { tiltDeg: 72 } } });
  assert.equal(created.json.status, 'created');
  const active = (await t.call('GET', '/me/incidents/active', { token })).json.incident;
  assert.equal(active.id, created.json.incidentId);
  assert.equal(active.source, 'device');

  // 기기가 1분 넘게 조용하면 끊긴 것으로 본다
  await t.advance(61);
  assert.equal((await t.call('GET', '/me', { token })).json.device.connected, false);

  assert.equal((await t.call('POST', '/device-api/heartbeat', { headers: { authorization: 'Device nope' }, body: {} })).status, 401);
});

test('비상연락처 순위 변경·삭제 시 순위를 다시 매긴다', async () => {
  const t = await setup();
  const { token, family, coworker, other } = await withContacts(t);
  await t.call('PATCH', `/me/contacts/${other.id}`, { token, body: { priority: 1 } });
  let me = (await t.call('GET', '/me', { token })).json;
  assert.deepEqual(me.contacts.map((c: { name: string; priority: number }) => `${c.priority}${c.name}`), ['1친구', '2엄마', '3박동료']);

  await t.call('DELETE', `/me/contacts/${family.id}`, { token });
  me = (await t.call('GET', '/me', { token })).json;
  assert.deepEqual(me.contacts.map((c: { name: string; priority: number }) => `${c.priority}${c.name}`), ['1친구', '2박동료']);
  assert.equal(coworker.priority, 2);

  const own = await t.call('POST', '/me/contacts', { token, body: { name: '나', relation: 'other', phone: '010-1234-5678' } });
  assert.equal(own.json.error.code, 'own_phone');
});
