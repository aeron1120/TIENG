import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

type T = Awaited<ReturnType<typeof setup>>;

/** 관제사(대행사 등록까지)와 그 코드로 소속된 라이더 */
async function agencyWithRider(t: T) {
  const boss = await t.login('010-9000-0001');
  await t.call('PUT', '/me/role', { token: boss, body: { role: 'dispatcher' } });
  const created = await t.call('POST', '/me/agency', { token: boss, body: { name: '강남 바로배달' } });
  assert.equal(created.status, 201);
  const code = created.json.agency.joinCode as string;
  const rider = await t.login('010-9000-0002');
  await t.call('PUT', '/me/role', { token: rider, body: { role: 'rider' } });
  await t.call('PATCH', '/me', { token: rider, body: { name: '김라이더' } });
  const joined = await t.call('PUT', '/me/affiliation', { token: rider, body: { joinCode: code.toLowerCase(), platforms: ['baemin', 'coupangeats'] } });
  assert.equal(joined.status, 200);
  const riderId = joined.json.rider.id as string;
  return { boss, rider, riderId, code };
}

test('라이더는 가입 코드로 대행사에 소속되고, 대행사 없이 플랫폼만 고를 수도 있다', async () => {
  const t = await setup();
  const { rider } = await agencyWithRider(t);
  const me = (await t.call('GET', '/me', { token: rider })).json;
  assert.equal(me.affiliation.agency.name, '강남 바로배달');
  assert.deepEqual(me.affiliation.platforms, ['baemin', 'coupangeats']);
  assert.ok(me.affiliation.joinedAt);

  const wrong = await t.call('PUT', '/me/affiliation', { token: rider, body: { joinCode: 'ZZZZZZ', platforms: [] } });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.json.error.code, 'agency_not_found');

  const solo = await t.login('010-9000-0003');
  assert.equal((await t.call('GET', '/me', { token: solo })).json.affiliation, null);
  // 코드를 빼고 보내면 소속은 그대로, 플랫폼만 바뀐다
  const kept = await t.call('PUT', '/me/affiliation', { token: rider, body: { platforms: ['ddangyo'] } });
  assert.equal(kept.json.affiliation.agency.name, '강남 바로배달');
  assert.deepEqual(kept.json.affiliation.platforms, ['ddangyo']);

  const direct = await t.call('PUT', '/me/affiliation', { token: solo, body: { joinCode: null, platforms: ['yogiyo'] } });
  assert.equal(direct.json.affiliation.agency, null);
  assert.deepEqual(direct.json.affiliation.platforms, ['yogiyo']);
});

test('관제 화면은 관제사만, 자기 대행사 소속만 — 위치는 보호 중일 때만 보이고 이용 기록이 남는다', async () => {
  const t = await setup();
  const { boss, rider, riderId } = await agencyWithRider(t);
  // 배달기사는 관제 화면을 못 연다
  assert.equal((await t.call('GET', '/me/agency', { token: rider })).status, 403);

  let board = (await t.call('GET', '/me/agency', { token: boss })).json;
  assert.equal(board.riders.length, 1);
  assert.equal(board.riders[0].protecting, false);
  assert.equal(board.riders[0].location, null);

  const session = await t.call('POST', '/me/session', { token: rider });
  await t.call('POST', `/me/sessions/${session.json.id}/locations`, { token: rider, body: { points: [{ recordedAt: new Date(t.now()).toISOString(), lat: 37.5, lng: 127.03 }] } });
  board = (await t.call('GET', '/me/agency', { token: boss })).json;
  assert.equal(board.riders[0].protecting, true);
  assert.deepEqual([board.riders[0].location.lat, board.riders[0].location.lng], [37.5, 127.03]);
  const access = (await t.call('GET', '/me/location-access', { token: rider })).json.items;
  assert.ok(access.some((a: { accessor: string }) => a.accessor.startsWith('강남 바로배달 관제')));

  // 라이더 가입 코드를 아는 사람이 관제사로 합류해 위치를 볼 수 없다 — 관제사는 관제사 초대 코드로만
  const { joinCode, staffCode } = board.agency;
  assert.notEqual(joinCode, staffCode);
  const intruder = await t.login('010-9000-0008');
  await t.call('PUT', '/me/role', { token: intruder, body: { role: 'dispatcher' } });
  const sneak = await t.call('PUT', '/me/affiliation', { token: intruder, body: { joinCode, platforms: [] } });
  assert.equal(sneak.status, 404);
  assert.equal((await t.call('GET', '/me/agency', { token: intruder })).json.agency, null);
  const staff = await t.call('PUT', '/me/affiliation', { token: intruder, body: { joinCode: staffCode, platforms: [] } });
  assert.equal(staff.status, 200);
  assert.equal((await t.call('GET', '/me/agency', { token: intruder })).json.riders.length, 1);
  // 배달기사는 관제사 초대 코드로 소속될 수 없다(라이더 가입 코드만)
  assert.equal((await t.call('PUT', '/me/affiliation', { token: rider, body: { joinCode: staffCode, platforms: ['baemin'] } })).status, 404);

  // 다른 대행사 관제사에게는 보이지 않는다
  const other = await t.login('010-9000-0009');
  await t.call('PUT', '/me/role', { token: other, body: { role: 'dispatcher' } });
  await t.call('POST', '/me/agency', { token: other, body: { name: '다른 대행' } });
  assert.equal((await t.call('GET', '/me/agency', { token: other })).json.riders.length, 0);
  // 다른 대행사 라이더에게는 주문을 줄 수 없다
  const foreign = await t.call('POST', '/me/agency/orders', { token: other, body: { riderId, platform: 'baemin', storeName: 'A', destination: 'B' } });
  assert.equal(foreign.status, 404);
});

test('배정한 주문은 사고 때 보류되고, 관제사가 접수·대체 배차·대응 완료한다', async () => {
  const t = await setup();
  const { boss, rider, riderId } = await agencyWithRider(t);
  const second = await t.login('010-9000-0004');
  await t.call('PATCH', '/me', { token: second, body: { name: '이대체' } });
  const { code } = { code: (await t.call('GET', '/me/agency', { token: boss })).json.agency.joinCode };
  const secondId = (await t.call('PUT', '/me/affiliation', { token: second, body: { joinCode: code, platforms: ['baemin'] } })).json.rider.id;

  const assigned = await t.call('POST', '/me/agency/orders', { token: boss, body: { riderId, platform: 'baemin', storeName: '역삼 김밥천국', destination: '테헤란로 152' } });
  assert.equal(assigned.status, 201);
  assert.equal((await t.call('GET', '/me', { token: rider })).json.affiliation.orders[0].platform, 'baemin');

  await t.call('POST', '/me/session', { token: rider });
  const incident = (await t.call('POST', '/me/incidents', { token: rider, body: { source: 'phone', kind: 'impact' } })).json.incident;
  let board = (await t.call('GET', '/me/agency', { token: boss })).json;
  assert.equal(board.incidents[0].status, 'countdown');
  assert.equal(board.riders.find((r: { id: string }) => r.id === riderId).openIncidentId, incident.id);

  // 카운트다운 중에는 닫을 수 없다(라이더 응답 대기)
  assert.equal((await t.call('POST', `/me/agency/incidents/${incident.id}/resolve`, { token: boss })).status, 409);
  await t.advance(31);
  board = (await t.call('GET', '/me/agency', { token: boss })).json;
  assert.equal(board.incidents[0].status, 'escalated');
  const held = board.orders.find((o: { status: string }) => o.status === 'held');
  assert.ok(held, '사고 라이더의 주문이 보류된다');
  // 대행사 주문은 외부 배차 요청으로 보내지 않는다 — 관제사가 직접 넘긴다
  assert.deepEqual(t.reassigned, []);

  board = (await t.call('POST', `/me/agency/incidents/${incident.id}/ack`, { token: boss })).json;
  assert.ok(board.incidents[0].ack.by);
  board = (await t.call('POST', `/me/agency/orders/${held.id}/reassign`, { token: boss, body: { riderId: secondId } })).json;
  assert.ok(board.orders.some((o: { riderId: string; status: string }) => o.riderId === secondId && o.status === 'assigned'));
  assert.ok(board.orders.some((o: { id: string; status: string }) => o.id === held.id && o.status === 'reassigned'));

  board = (await t.call('POST', `/me/agency/incidents/${incident.id}/resolve`, { token: boss })).json;
  assert.equal(board.incidents[0].status, 'resolved');
  assert.equal(board.incidents[0].resolution, 'handled');
});

test('진행 중인 주문이 있으면 소속을 바꿀 수 없다', async () => {
  const t = await setup();
  const { boss, rider, riderId } = await agencyWithRider(t);
  await t.call('POST', '/me/agency/orders', { token: boss, body: { riderId, platform: 'yogiyo', storeName: 'A', destination: 'B' } });
  const leave = await t.call('PUT', '/me/affiliation', { token: rider, body: { joinCode: null, platforms: ['yogiyo'] } });
  assert.equal(leave.status, 409);
  const orderId = (await t.call('GET', '/me/agency', { token: boss })).json.orders[0].id;
  await t.call('POST', `/me/agency/orders/${orderId}/delivered`, { token: boss });
  assert.equal((await t.call('PUT', '/me/affiliation', { token: rider, body: { joinCode: null, platforms: ['yogiyo'] } })).status, 200);
});
