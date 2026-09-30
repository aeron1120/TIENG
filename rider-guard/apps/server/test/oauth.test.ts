import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

import { processDue } from '../src/services/scheduler.ts';
import { httpSocialAuth } from '../src/services/social.ts';
import { setup } from './helpers.ts';

const KEYS = {
  KAKAO_REST_API_KEY: 'kakao-id',
  KAKAO_CLIENT_SECRET: 'kakao-secret',
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
};
const APP = 'riderguard://auth/callback';
const WEB_APP = 'https://tieng.pages.dev/auth/callback';
const EXPO_APP = 'https://rider-guard.expo.app/auth/callback';
type T = Awaited<ReturnType<typeof setup>>;

/** 앱이 로그인 시작 → 제공자 로그인 주소에서 state 를 꺼낸다. sessionKey 는 앱만 가진다. */
async function start(t: T, provider = 'kakao', redirectUri = APP) {
  const res = await t.call('POST', `/auth/oauth/${provider}/start`, { body: { redirectUri } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const url = new URL(res.json.authorizeUrl);
  assert.ok(!res.json.authorizeUrl.includes(res.json.sessionKey), 'sessionKey 는 브라우저로 가는 주소에 실리면 안 된다');
  return { url, state: url.searchParams.get('state')!, sessionKey: res.json.sessionKey as string };
}

const exchange = (t: T, code: string, sessionKey: string) => t.call('POST', '/auth/oauth/exchange', { body: { code, sessionKey } });

/** 제공자가 서버 콜백을 부른 것처럼 */
const callback = (t: T, provider: string, params: Record<string, string>) =>
  t.call('GET', `/auth/oauth/${provider}/callback?${new URLSearchParams(params)}`);

const location = (res: { headers: Headers }) => new URL(res.headers.get('location')!);

/** 시작 → 콜백 → 1회용 코드 → 토큰까지 */
async function socialLogin(t: T, provider: 'kakao' | 'google', subject: string, extra: { name?: string | null; phone?: string | null; email?: string | null } = {}) {
  const code = `code-${provider}-${subject}-${Math.random()}`;
  t.socialProfiles.set(code, { provider, subject, email: extra.email ?? null, name: extra.name ?? null, phone: extra.phone ?? null });
  const { state, sessionKey } = await start(t, provider);
  const back = await callback(t, provider, { code, state });
  assert.equal(back.status, 302);
  const loginCode = location(back).searchParams.get('code')!;
  const exchanged = await exchange(t, loginCode, sessionKey);
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.json));
  return exchanged.json as { token: string; isNew: boolean; onboarded: boolean };
}

test('로그인 버튼은 서버에 키가 둘 다 있는 제공자만', async () => {
  const t = await setup({ ...KEYS, NAVER_CLIENT_ID: 'only-id' });
  assert.deepEqual((await t.call('GET', '/auth/providers')).json, { email: true, social: ['kakao', 'google'] });
  const naver = await t.call('POST', '/auth/oauth/naver/start', { body: { redirectUri: APP } });
  assert.equal(naver.status, 404);
});

test('운영 웹: Google 콜백은 API 서버로, 로그인 결과는 tieng.pages.dev로 돌아온다', async () => {
  const t = await setup({
    ...KEYS,
    NODE_ENV: 'production',
    OPS_TOKEN: 'x'.repeat(24),
    PUBLIC_BASE_URL: 'https://rider-guard-api.onrender.com',
  });
  const { url, state, sessionKey } = await start(t, 'google', WEB_APP);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://rider-guard-api.onrender.com/auth/oauth/google/callback');
  t.socialProfiles.set('web-google-code', { provider: 'google', subject: 'web-rider', email: null, name: null, phone: null });
  const back = await callback(t, 'google', { code: 'web-google-code', state });
  assert.equal(back.status, 302);
  const target = location(back);
  assert.equal(target.origin + target.pathname, WEB_APP);
  const result = await exchange(t, target.searchParams.get('code')!, sessionKey);
  assert.equal(result.status, 200);
  assert.ok(result.json.token);
});

test('운영 웹 복귀 주소는 등록된 콜백 하나만 허용한다', async () => {
  const t = await setup({ ...KEYS, NODE_ENV: 'production', OPS_TOKEN: 'x'.repeat(24) });
  assert.equal((await t.call('POST', '/auth/oauth/google/start', { body: { redirectUri: EXPO_APP } })).status, 200);
  for (const bad of [
    'https://tieng.pages.dev.evil.example/auth/callback',
    'https://preview.tieng.pages.dev/auth/callback',
    'https://tieng.pages.dev@evil.example/auth/callback',
    'https://user:pass@tieng.pages.dev/auth/callback',
    'http://tieng.pages.dev/auth/callback',
    'https://tieng.pages.dev/',
    `${WEB_APP}/`,
    `${WEB_APP}?next=https://evil.example`,
    `${WEB_APP}#fragment`,
  ]) {
    const result = await t.call('POST', '/auth/oauth/google/start', { body: { redirectUri: bad } });
    assert.equal(result.status, 400, bad);
    assert.equal(result.json.error.code, 'invalid_redirect', bad);
  }
});

test('동시 콜백은 state 를 한 번만 소비하고 한 번만 코드 교환한다', async () => {
  const t = await setup(KEYS);
  t.socialProfiles.set('same-code', { provider: 'google', subject: 'one', email: null, name: null, phone: null });
  const { state } = await start(t, 'google');
  const responses = await Promise.all(Array.from({ length: 8 }, () => callback(t, 'google', { state, code: 'same-code' })));
  assert.equal(responses.filter((r) => r.status === 302).length, 1);
  assert.equal(responses.filter((r) => r.status === 400).length, 7);
  assert.equal(t.socialCalls.length, 1);
});

test('동시 로그인 코드 교환은 Rider Guard 토큰을 하나만 발급한다', async () => {
  const t = await setup(KEYS);
  t.socialProfiles.set('one-code', { provider: 'google', subject: 'one', email: null, name: null, phone: null });
  const { state, sessionKey } = await start(t, 'google');
  const code = location(await callback(t, 'google', { state, code: 'one-code' })).searchParams.get('code')!;
  const responses = await Promise.all(Array.from({ length: 8 }, () => exchange(t, code, sessionKey)));
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal(responses.filter((r) => r.status === 400).length, 7);
  assert.equal((await t.ctx.db.all('SELECT 1 FROM authTokens')).length, 1);
});

test('Google callback uses the PKCE verifier and nonce bound to its state', async () => {
  const t = await setup(KEYS);
  t.socialProfiles.set('google-code', { provider: 'google', subject: 'stable-sub', email: null, name: null, phone: null });
  const { state } = await start(t, 'google');
  assert.equal((await callback(t, 'google', { state, code: 'google-code' })).status, 302);
  const call = t.socialCalls[0]!;
  assert.ok(call.verifier && call.nonce);
  const row = await t.ctx.db.get('SELECT 1 FROM oauthStates WHERE state = :state', { state });
  assert.equal(row, undefined);
});

test('Google 인가 요청은 S256 PKCE 와 nonce 를 제공자에 전달한다', () => {
  const verifier = 'a'.repeat(43);
  const nonce = 'nonce-123';
  const url = new URL(httpSocialAuth.authorizeUrl('google', { clientId: 'id', clientSecret: 'secret' }, 'https://api.test/callback', 'state-123', { verifier, nonce }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(url.searchParams.get('nonce'), nonce);
});

test('카카오: 시작 → 콜백 → 앱으로 1회용 코드 → 토큰, 가입 정보는 제공자 값으로 미리 채운다', async () => {
  const t = await setup(KEYS);
  const { url } = await start(t);
  assert.equal(url.origin + url.pathname, 'https://kakao.example/authorize');
  assert.equal(url.searchParams.get('client_id'), 'kakao-id');
  // 콜백 주소는 요청 Host 가 아니라 설정값(PUBLIC_BASE_URL)으로 만든다
  assert.equal(url.searchParams.get('redirect_uri'), 'https://rg.test/auth/oauth/kakao/callback');

  const first = await socialLogin(t, 'kakao', '1285016924429472463', { name: '김카카오', phone: '01098765432' });
  assert.deepEqual({ isNew: first.isNew, onboarded: first.onboarded }, { isNew: true, onboarded: false });
  // 서버가 제공자에 보낸 값: 등록한 콜백 주소와 시크릿
  assert.deepEqual(t.socialCalls[0], { provider: 'kakao', code: t.socialCalls[0]!.code, redirectUri: 'https://rg.test/auth/oauth/kakao/callback', clientSecret: 'kakao-secret' });

  const me = (await t.call('GET', '/me', { token: first.token })).json;
  assert.deepEqual(me.account, { email: null, hasPassword: false, social: ['kakao'] });
  assert.equal(me.rider.name, '김카카오');
  assert.equal(me.rider.phone, '01098765432');
  assert.equal(me.onboarded, false);

  // 같은 카카오 계정으로 다시 로그인하면 같은 라이더
  const again = await socialLogin(t, 'kakao', '1285016924429472463');
  assert.equal(again.isNew, false);
  assert.equal((await t.call('GET', '/me', { token: again.token })).json.rider.id, me.rider.id);
});

test('state 는 1회용·10분, 다른 제공자 콜백에 쓸 수 없다 (CSRF)', async () => {
  const t = await setup(KEYS);
  t.socialProfiles.set('c1', { provider: 'kakao', subject: 's1', email: null, name: null, phone: null });

  const { state } = await start(t);
  assert.equal((await callback(t, 'google', { code: 'c1', state })).status, 400); // 카카오로 시작한 state 를 구글 콜백에
  const { state: s2 } = await start(t);
  assert.equal((await callback(t, 'kakao', { code: 'c1', state: s2 })).status, 302);
  const reused = await callback(t, 'kakao', { code: 'c1', state: s2 });
  assert.equal(reused.status, 400);
  assert.match(reused.text, /로그인 요청이 만료됐어요/);

  const { state: s3 } = await start(t);
  await t.advance(10 * 60);
  assert.equal((await callback(t, 'kakao', { code: 'c1', state: s3 })).status, 400);
  assert.equal((await callback(t, 'kakao', { code: 'c1' })).status, 400); // state 없음
});

test('취소·교환 실패는 앱으로 error 를 돌려준다', async () => {
  const t = await setup(KEYS);
  const { state } = await start(t);
  const cancelled = await callback(t, 'kakao', { error: 'access_denied', error_description: 'User denied access', state });
  assert.equal(location(cancelled).searchParams.get('error'), 'cancelled');

  const { state: s2 } = await start(t);
  const failed = await callback(t, 'kakao', { code: 'unknown-code', state: s2 });
  assert.equal(failed.status, 302);
  assert.equal(location(failed).searchParams.get('error'), 'failed');
  assert.equal(location(failed).searchParams.get('code'), null);
});

test('1회용 로그인 코드는 한 번만, 60초 안에만', async () => {
  const t = await setup(KEYS);
  t.socialProfiles.set('c1', { provider: 'kakao', subject: 's1', email: null, name: null, phone: null });
  const { state, sessionKey } = await start(t);
  const code = location(await callback(t, 'kakao', { code: 'c1', state })).searchParams.get('code')!;
  assert.equal((await exchange(t, code, sessionKey)).status, 200);
  assert.equal((await exchange(t, code, sessionKey)).json.error.code, 'invalid_login_code');

  t.socialProfiles.set('c2', { provider: 'kakao', subject: 's1', email: null, name: null, phone: null });
  const { state: s2, sessionKey: k2 } = await start(t);
  const late = location(await callback(t, 'kakao', { code: 'c2', state: s2 })).searchParams.get('code')!;
  await t.advance(61);
  assert.equal((await exchange(t, late, k2)).status, 400);
});

test('1회용 코드는 로그인을 시작한 앱의 sessionKey 로만 바꿀 수 있다 (가로챈 코드·심은 코드 방지)', async () => {
  const t = await setup(KEYS);
  // 공격자: 자기 계정으로 로그인해 코드를 얻는다
  t.socialProfiles.set('attacker', { provider: 'kakao', subject: 'attacker', email: null, name: null, phone: null });
  const attacker = await start(t);
  const planted = location(await callback(t, 'kakao', { code: 'attacker', state: attacker.state })).searchParams.get('code')!;
  // 피해자 앱: 로그인을 시작해 자기 sessionKey 를 갖고 있다가 공격자 코드를 받는다
  const victim = await start(t);
  const res = await exchange(t, planted, victim.sessionKey);
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid_login_code');
  // 틀린 열쇠로 한 번 보인 코드는 지워진다 — 맞는 열쇠로도 더는 못 쓴다
  assert.equal((await exchange(t, planted, attacker.sessionKey)).status, 400);
  // 열쇠 없이는 요청 자체가 잘못됐다
  assert.equal((await t.call('POST', '/auth/oauth/exchange', { body: { code: planted } })).status, 400);
});

test('돌아갈 앱 주소 제한: 모바일 앱 스킴과 개발 환경의 Expo Go·localhost (열린 리다이렉트 방지)', async () => {
  const dev = await setup(KEYS);
  for (const ok of [APP, 'exp://10.0.0.5:8081/--/auth/callback', 'http://localhost:8081/auth/callback']) {
    assert.equal((await dev.call('POST', '/auth/oauth/kakao/start', { body: { redirectUri: ok } })).status, 200, ok);
  }
  for (const bad of ['https://evil.example/steal', 'http://10.0.0.5:8081/cb', 'javascript:alert(1)', 'not a url']) {
    assert.equal((await dev.call('POST', '/auth/oauth/kakao/start', { body: { redirectUri: bad } })).status, 400, bad);
  }
  const prod = await setup({ ...KEYS, NODE_ENV: 'production', OPS_TOKEN: 'x'.repeat(24) });
  assert.equal((await prod.call('POST', '/auth/oauth/kakao/start', { body: { redirectUri: APP } })).status, 200);
  assert.equal((await prod.call('POST', '/auth/oauth/kakao/start', { body: { redirectUri: 'exp://10.0.0.5:8081/--/cb' } })).status, 400);
  assert.equal((await prod.call('POST', '/auth/oauth/kakao/start', { body: { redirectUri: 'http://localhost:8081/cb' } })).status, 400);
});

test('이메일이 같아도 다른 로그인 수단의 계정에 자동으로 붙이지 않는다', async () => {
  const t = await setup(KEYS);
  const email = await t.call('POST', '/auth/signup', { body: { email: 'same@example.com', password: 'password123' } });
  const google = await socialLogin(t, 'google', '107691503500061507151130823', { email: 'same@example.com' });
  assert.equal(google.isNew, true);
  const a = (await t.call('GET', '/me', { token: email.json.token })).json.rider.id;
  const b = (await t.call('GET', '/me', { token: google.token })).json.rider.id;
  assert.notEqual(a, b);
});

test('카카오 회원이 탈퇴하면 카카오 연결 끊기를 보낸다 — 실패하면 다시, Admin 키가 없으면 쌓아 둔다', async () => {
  const withKey = await setup({ ...KEYS, KAKAO_ADMIN_KEY: 'admin-key' });
  const kakao = await socialLogin(withKey, 'kakao', '1285016924429472463');
  withKey.unlink.fails = true;
  assert.equal((await withKey.call('DELETE', '/me', { token: kakao.token })).status, 204);
  await withKey.advance(1);
  assert.deepEqual(withKey.unlinked, []);
  const [pending] = await withKey.ctx.db.all<{ attempts: number; error: string }>('SELECT attempts, error FROM socialUnlinks');
  assert.equal(pending?.attempts, 1);
  assert.match(pending!.error, /카카오 서버 오류/);

  withKey.unlink.fails = false;
  await withKey.advance(30); // 첫 재시도는 1분 뒤
  assert.deepEqual(withKey.unlinked, []);
  await withKey.advance(31);
  assert.deepEqual(withKey.unlinked, [{ subject: '1285016924429472463', adminKey: 'admin-key' }]);
  assert.equal((await withKey.ctx.db.all('SELECT 1 FROM socialUnlinks')).length, 0);

  // 구글 회원은 끊을 토큰이 없어 대상이 아니다
  const google = await socialLogin(withKey, 'google', 'g-1');
  await withKey.call('DELETE', '/me', { token: google.token });
  assert.equal((await withKey.ctx.db.all('SELECT 1 FROM socialUnlinks')).length, 0);

  // Admin 키가 없으면 보내지 않고 쌓아 둔다
  const noKey = await setup(KEYS);
  const k = await socialLogin(noKey, 'kakao', 'k-9');
  await noKey.call('DELETE', '/me', { token: k.token });
  await noKey.advance(60);
  assert.deepEqual(noKey.unlinked, []);
  assert.equal((await noKey.ctx.db.all('SELECT 1 FROM socialUnlinks')).length, 1);
});

test('탈퇴 뒤 같은 카카오 계정으로 다시 가입하면 대기 중이던 연결 끊기는 취소된다', async () => {
  const t = await setup(KEYS); // Admin 키 없음 — 끊기가 쌓여 있는 상태
  const first = await socialLogin(t, 'kakao', '4000000000000000001');
  await t.call('DELETE', '/me', { token: first.token });
  assert.equal((await t.ctx.db.all('SELECT 1 FROM socialUnlinks')).length, 1);
  const again = await socialLogin(t, 'kakao', '4000000000000000001');
  assert.equal(again.isNew, true);
  assert.equal((await t.ctx.db.all('SELECT 1 FROM socialUnlinks')).length, 0);

  // 보내기 직전에도 확인한다: 활성 계정의 회원번호로 들어간 끊기 요청은 보내지 않고 지운다
  await t.ctx.db.run("INSERT INTO socialUnlinks (provider, subject, dueAt) VALUES ('kakao', '4000000000000000001', 0)");
  t.ctx.config.kakaoAdminKey = 'admin-key';
  await t.advance(1);
  assert.deepEqual(t.unlinked, []);
  assert.equal((await t.ctx.db.all('SELECT 1 FROM socialUnlinks')).length, 0);
});

test('카카오가 응답하지 않아도 사고 대응 루프는 멈추지 않는다 (정리 작업은 따로 돈다)', async () => {
  const t = await setup({ ...KEYS, KAKAO_ADMIN_KEY: 'admin-key' });
  const kakao = await socialLogin(t, 'kakao', 'k-hang');
  await t.call('DELETE', '/me', { token: kakao.token });
  t.unlink.hangs = true;
  // 사고 대응 루프(processDue)는 카카오를 부르지 않으므로 바로 끝난다
  const done = await Promise.race([processDue(t.ctx).then(() => 'done'), new Promise((r) => setTimeout(() => r('stuck'), 1000))]);
  assert.equal(done, 'done');
});

test('SNS 계정으로 탈퇴하면 연결도 지워지고, 다시 로그인하면 새 계정', async () => {
  const t = await setup(KEYS);
  const first = await socialLogin(t, 'kakao', 'k-1');
  const firstId = (await t.call('GET', '/me', { token: first.token })).json.rider.id;
  assert.equal((await t.call('DELETE', '/me', { token: first.token })).status, 204);
  const again = await socialLogin(t, 'kakao', 'k-1');
  assert.equal(again.isNew, true);
  assert.notEqual((await t.call('GET', '/me', { token: again.token })).json.rider.id, firstId);
});
