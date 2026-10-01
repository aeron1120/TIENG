import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

type T = Awaited<ReturnType<typeof setup>>;
const KEYS = { KAKAO_REST_API_KEY: 'kakao-id', KAKAO_CLIENT_SECRET: 'kakao-secret', ADMIN_EMAILS: ' Boss@Example.com , ops@example.com' };
const APP = 'riderguard://auth/callback';

/** 카카오 로그인 — 제공자가 준 (인증된) 이메일과 함께 */
async function kakaoLogin(t: T, subject: string, email: string | null) {
  const code = `code-${subject}`;
  t.socialProfiles.set(code, { provider: 'kakao', subject, email, name: null, phone: null });
  const start = await t.call('POST', '/auth/oauth/kakao/start', { body: { redirectUri: APP } });
  const url = new URL(start.json.authorizeUrl);
  const back = await t.call('GET', `/auth/oauth/kakao/callback?${new URLSearchParams({ code, state: url.searchParams.get('state')! })}`);
  const loginCode = new URL(back.headers.get('location')!).searchParams.get('code')!;
  return (await t.call('POST', '/auth/oauth/exchange', { body: { code: loginCode, sessionKey: start.json.sessionKey } })).json.token as string;
}

test('첫 로그인에는 역할이 없고, 배달기사·관제사를 고르고 바꿀 수 있다', async () => {
  const t = await setup(KEYS);
  const token = await t.login();
  assert.equal((await t.call('GET', '/me', { token })).json.role, null);
  const r = await t.call('PUT', '/me/role', { token, body: { role: 'dispatcher' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.role, 'dispatcher');
  assert.equal((await t.call('PUT', '/me/role', { token, body: { role: 'rider' } })).json.role, 'rider');
  // 관리자는 고를 수 없다
  assert.equal((await t.call('PUT', '/me/role', { token, body: { role: 'admin' } })).status, 400);
});

test('ADMIN_EMAILS 의 인증된 SNS 이메일로 로그인하면 관리자 — 대소문자·공백 무시, 고른 역할보다 우선', async () => {
  const t = await setup(KEYS);
  const token = await kakaoLogin(t, 'boss-1', 'boss@example.com');
  assert.equal((await t.call('GET', '/me', { token })).json.role, 'admin');
  await t.call('PUT', '/me/role', { token, body: { role: 'rider' } });
  assert.equal((await t.call('GET', '/me', { token })).json.role, 'admin');
  const overview = await t.call('GET', '/me/admin/overview', { token });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.ruleCheck.total, 29);
  assert.ok(overview.json.riders.total >= 1);
  assert.ok(Array.isArray(overview.json.incidents));
});

test('이메일 가입은 관리자 주소여도 관리자가 아니다 (메일 인증 없음), 관리자가 아니면 운영 현황을 못 본다', async () => {
  const t = await setup(KEYS);
  const signup = await t.call('POST', '/auth/signup', { body: { email: 'boss@example.com', password: 'password123' } });
  const token = signup.json.token as string;
  assert.equal((await t.call('GET', '/me', { token })).json.role, null);
  assert.equal((await t.call('GET', '/me/admin/overview', { token })).status, 403);
  const other = await kakaoLogin(t, 'someone', 'someone@example.com');
  assert.equal((await t.call('GET', '/me/admin/overview', { token: other })).status, 403);
});
