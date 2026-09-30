import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

const consents = { locationSensor: true, shareOnIncident: true, insuranceRecords: false };
const signup = (t: Awaited<ReturnType<typeof setup>>, email = 'rider@example.com', password = 'password123') =>
  t.call('POST', '/auth/signup', { body: { email, password } });

test('이메일로 가입 → 가입 정보 입력 전에는 운행을 시작할 수 없다 → 입력 후 시작', async () => {
  const t = await setup();
  const res = await signup(t, ' Rider@Example.com ');
  assert.equal(res.status, 201);
  assert.deepEqual({ isNew: res.json.isNew, onboarded: res.json.onboarded }, { isNew: true, onboarded: false });
  const token = res.json.token;

  const before = (await t.call('GET', '/me', { token })).json;
  assert.equal(before.onboarded, false);
  assert.equal(before.rider.email, 'rider@example.com'); // 소문자·공백 정리
  assert.equal(before.rider.phone, null);
  assert.deepEqual(before.account, { email: 'rider@example.com', hasPassword: true, social: [] });

  const blocked = await t.call('POST', '/me/session', { token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'onboarding_required');

  const onboarded = await t.call('POST', '/me/onboarding', { token, body: { name: '김라이더', phone: '010-1234-5678', consents } });
  assert.equal(onboarded.status, 200);
  assert.equal(onboarded.json.onboarded, true);
  assert.equal(onboarded.json.rider.phone, '01012345678');
  assert.equal((await t.call('POST', '/me/session', { token })).status, 200);
});

test('가입 정보: 필수 동의가 빠지거나 휴대폰 번호가 아니면 거절', async () => {
  const t = await setup();
  const { token } = (await signup(t)).json;
  const noConsent = await t.call('POST', '/me/onboarding', {
    token,
    body: { name: '김라이더', phone: '01012345678', consents: { ...consents, shareOnIncident: false } },
  });
  assert.equal(noConsent.json.error.code, 'consent_required');
  const landline = await t.call('POST', '/me/onboarding', { token, body: { name: '김라이더', phone: '02-123-4567', consents } });
  assert.equal(landline.status, 400);
  assert.equal((await t.call('GET', '/me', { token })).json.onboarded, false);
});

test('같은 이메일로 두 번 가입할 수 없고, 비밀번호는 8자 이상', async () => {
  const t = await setup();
  await signup(t);
  const dup = await signup(t, 'RIDER@example.com');
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'email_taken');
  assert.equal((await signup(t, 'other@example.com', 'short')).status, 400);
  assert.equal((await signup(t, 'not-an-email', 'password123')).status, 400);
});

test('이메일 로그인: 없는 이메일과 틀린 비밀번호는 같은 답, 5번 틀리면 맞는 비밀번호도 15분 잠김', async () => {
  const t = await setup();
  await signup(t);
  const unknown = await t.call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'password123' } });
  const wrong = await t.call('POST', '/auth/login', { body: { email: 'rider@example.com', password: 'wrong-password' } });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.json, wrong.json);

  for (let i = 0; i < 4; i++) await t.call('POST', '/auth/login', { body: { email: 'rider@example.com', password: 'wrong-password' } });
  const locked = await t.call('POST', '/auth/login', { body: { email: 'rider@example.com', password: 'password123' } });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'login_locked');

  await t.advance(15 * 60);
  const ok = await t.call('POST', '/auth/login', { body: { email: 'RIDER@example.com', password: 'password123' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.onboarded, false);
});

test('잠금은 동시에 보낸 요청으로도 못 피한다: 잠금 창 하나에서 비밀번호 확인은 최대 5번', async () => {
  const t = await setup();
  await signup(t);
  const attempt = (password: string) => t.call('POST', '/auth/login', { body: { email: 'rider@example.com', password } });

  // 틀린 비밀번호 20개를 한꺼번에 — 5개만 확인까지 가고 나머지는 429
  const burst = await Promise.all(Array.from({ length: 20 }, () => attempt('wrong-password')));
  const count = (status: number) => burst.filter((r) => r.status === status).length;
  assert.deepEqual({ checked: count(401), locked: count(429) }, { checked: 5, locked: 15 });
  // 잠긴 뒤에는 맞는 비밀번호도 안 된다
  assert.equal((await attempt('password123')).status, 429);

  // 맞는 비밀번호가 섞여 있어도 확인은 5번까지. 그 뒤 잠금이 풀리지 않는다.
  await t.advance(15 * 60);
  const mixed = await Promise.all([...Array.from({ length: 10 }, () => attempt('wrong-password')), attempt('password123')]);
  assert.ok(mixed.filter((r) => r.status !== 429).length <= 5, mixed.map((r) => r.status).join(','));
  if (!mixed.some((r) => r.status === 200)) assert.equal((await attempt('password123')).status, 429);

  await t.advance(15 * 60);
  assert.equal((await attempt('password123')).status, 200);
});

test('확인 도중 끝나지 못한 시도(크래시·DB 오류)가 남아도 영영 잠기지 않는다 — 보통 잠금으로 바뀌어 15분 뒤 풀린다', async () => {
  const t = await setup();
  await signup(t);
  // 5번째 시도를 센 뒤 서버가 죽은 상태: 한도까지 셌는데 잠금 시각이 없다
  await t.ctx.db.run("UPDATE riders SET loginFailures = 5, lockedUntil = NULL WHERE email = 'rider@example.com'");
  const attempt = () => t.call('POST', '/auth/login', { body: { email: 'rider@example.com', password: 'password123' } });
  const locked = await attempt();
  assert.equal(locked.status, 429);
  assert.match(locked.json.error.message, /15분 뒤/);
  await t.advance(15 * 60);
  assert.equal((await attempt()).status, 200);
});

test('로그아웃하면 토큰이 무효, 토큰 없이 /me 는 401', async () => {
  const t = await setup();
  const token = await t.login();
  assert.equal((await t.call('POST', '/auth/logout', { token })).status, 204);
  assert.equal((await t.call('GET', '/me', { token })).status, 401);
  assert.equal((await t.call('GET', '/me')).status, 401);
});

test('회원 탈퇴: 내 데이터가 지워지고, 위치 이용내역은 법정 보존 기간(6개월) 동안만 남는다', async () => {
  const t = await setup();
  const token = await t.login();
  await t.call('POST', '/me/contacts', { token, body: { name: '엄마', relation: 'family', phone: '01011111111' } });
  await t.call('POST', '/me/session', { token });
  const inc = (await t.call('POST', '/me/incidents', { token, body: { source: 'phone', kind: 'impact' } })).json.incident;

  // 사고 대응 중에는 탈퇴할 수 없다
  const blocked = await t.call('DELETE', '/me', { token });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'incident_open');

  await t.call('POST', `/me/incidents/${inc.id}/respond`, { token, body: { response: 'ok' } });
  const riderId = (await t.call('GET', '/me', { token })).json.rider.id;
  await t.ctx.db.run(
    "INSERT INTO locationAccessLogs (riderId, incidentId, accessorKey, accessor, purpose, at) VALUES (:riderId, NULL, 'contact:x', '1순위 엄마 (가족)', 'standing', :at)",
    { riderId, at: t.now() },
  );

  assert.equal((await t.call('DELETE', '/me', { token })).status, 204);
  assert.equal((await t.call('GET', '/me', { token })).status, 401);
  for (const table of ['riders', 'contacts', 'sessions', 'incidents', 'incidentEvents', 'consents', 'authTokens']) {
    const rows = await t.ctx.db.all(`SELECT 1 FROM ${table}`);
    assert.equal(rows.length, 0, `${table} 가 남아 있다`);
  }
  assert.equal((await t.ctx.db.all('SELECT 1 FROM locationAccessLogs')).length, 1);

  // 같은 이메일로 다시 가입할 수 있다
  assert.equal((await t.call('POST', '/auth/signup', { body: { email: '01012345678@rider.test', password: 'password123' } })).status, 201);

  // 6개월(184일)이 지나면 스케줄러가 파기한다
  await t.advance(183 * 24 * 3600);
  assert.equal((await t.ctx.db.all('SELECT 1 FROM locationAccessLogs')).length, 1);
  await t.advance(2 * 24 * 3600);
  assert.equal((await t.ctx.db.all('SELECT 1 FROM locationAccessLogs')).length, 0);
});

test('의료정보는 별도 동의가 있어야 저장된다 (민감정보, 9.3)', async () => {
  const t = await setup();
  const token = await t.login();
  const denied = await t.call('PATCH', '/me', { token, body: { medical: { bloodType: 'A+' } } });
  assert.equal(denied.status, 403);

  await t.call('PUT', '/me/consents/medicalInfo', { token, body: { granted: true } });
  const saved = await t.call('PATCH', '/me', { token, body: { name: '김라이더', medical: { bloodType: 'A+' } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.medical.bloodType, 'A+');

  // 동의를 철회하면 저장된 의료정보도 지운다.
  await t.call('PUT', '/me/consents/medicalInfo', { token, body: { granted: false } });
  const me = await t.call('GET', '/me', { token });
  assert.equal(me.json.rider.medical, null);

  const required = await t.call('PUT', '/me/consents/locationSensor', { token, body: { granted: false } });
  assert.equal(required.status, 400);
});

test('로그인 수단 목록: 이메일은 항상, SNS 는 서버에 키가 있을 때만', async () => {
  const t = await setup();
  const res = await t.call('GET', '/auth/providers');
  assert.deepEqual(res.json, { email: true, social: [] });
});
