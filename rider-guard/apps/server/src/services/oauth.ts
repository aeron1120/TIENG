import type { AuthResponse, SocialProvider } from '@rider-guard/contract';

import type { AppContext } from '../context.ts';
import { ApiError, newToken, safeEqual, sha256 } from '../lib.ts';
import { findOrCreateSocialRider, issueToken } from './auth.ts';
import { getRider, isOnboarded } from './riders.ts';
import { SocialAuthError } from './social.ts';

/**
 * SNS 로그인 흐름
 *   1. 앱: POST /auth/oauth/:provider/start {redirectUri}  → 서버가 state 를 저장하고 제공자 로그인 주소와 sessionKey 를 준다
 *   2. 브라우저: 제공자 로그인 → 제공자가 서버 콜백으로 code·state 전달
 *   3. 서버: state 확인(1회용·10분) → code 교환 → 라이더 찾기/만들기 → 60초짜리 1회용 코드를 만들어 앱 주소로 302
 *   4. 앱: POST /auth/oauth/exchange {code, sessionKey} → 로그인 토큰
 *
 * 로그인 토큰을 주소(딥링크)에 싣지 않는 이유: 주소는 브라우저 기록·다른 앱에 남을 수 있다. 1회용 코드는 한 번 쓰면 끝.
 * sessionKey: 1회용 코드를 로그인을 시작한 앱에 묶는다(PKCE 와 같은 역할). 브라우저·딥링크를 거치지 않고 1의 응답으로만
 * 앱에 전해지므로, 같은 스킴을 가로챈 다른 앱은 코드를 써먹지 못하고, 남의 코드를 심은 링크(login CSRF)는 교환되지 않는다.
 */

const STATE_TTL_MS = 10 * 60_000;
const LOGIN_CODE_TTL_MS = 60_000;

export const PROVIDERS: SocialProvider[] = ['kakao', 'naver', 'google'];

export const enabledProviders = (ctx: AppContext) => PROVIDERS.filter((p) => ctx.config.oauth[p]);

/** 제공자 개발자 콘솔에 등록하는 콜백 주소. 요청의 Host 가 아니라 설정값으로만 만든다(프록시 뒤에서 http 로 바뀌는 사고 방지). */
export const callbackUrl = (ctx: AppContext, provider: SocialProvider) => `${ctx.config.publicBaseUrl}/auth/oauth/${provider}/callback`;

/**
 * 로그인이 끝나고 돌아갈 앱 주소. 아무 주소나 받으면 로그인 코드를 남의 사이트로 넘기는 통로가 된다.
 * 운영: 앱 스킴(riderguard://)과 배포 웹의 정확한 콜백만. 개발: Expo Go와 localhost도.
 */
function allowedAppRedirect(ctx: AppContext, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === `${ctx.config.appScheme}:`) return true;
  if (raw === 'https://tieng.pages.dev/auth/callback') return true;
  if (ctx.config.env === 'production') return false;
  if (url.protocol === 'exp:' || url.protocol === 'exps:') return true;
  return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function credentials(ctx: AppContext, provider: string) {
  const creds = (PROVIDERS as string[]).includes(provider) ? ctx.config.oauth[provider as SocialProvider] : undefined;
  if (!creds) throw new ApiError(404, 'provider_disabled', '지원하지 않는 로그인 방식이에요.');
  return { provider: provider as SocialProvider, creds };
}

export async function startOAuth(ctx: AppContext, providerName: string, appRedirect: string): Promise<{ authorizeUrl: string; sessionKey: string }> {
  const { provider, creds } = credentials(ctx, providerName);
  if (!allowedAppRedirect(ctx, appRedirect)) throw new ApiError(400, 'invalid_redirect', '앱으로 돌아갈 주소가 올바르지 않아요.');
  const state = newToken();
  const sessionKey = newToken();
  const now = ctx.clock.now();
  await ctx.db.run(
    'INSERT INTO oauthStates (state, provider, appRedirect, keyHash, createdAt, expiresAt) VALUES (:state, :provider, :appRedirect, :keyHash, :now, :expiresAt)',
    { state, provider, appRedirect, keyHash: sha256(sessionKey), now, expiresAt: now + STATE_TTL_MS },
  );
  return { authorizeUrl: ctx.providers.social.authorizeUrl(provider, creds, callbackUrl(ctx, provider), state), sessionKey };
}

const withQuery = (base: string, params: Record<string, string>) => `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;

export type CallbackResult = { kind: 'redirect'; location: string } | { kind: 'page'; status: 400; message: string };

/**
 * 제공자 → 서버 콜백. state 로 시작한 요청인지 확인하고(CSRF), 한 번 쓰면 지운다.
 * state 를 모르면 돌아갈 앱 주소도 모르므로 리다이렉트하지 않고 안내 페이지를 보여 준다.
 */
export async function completeOAuth(
  ctx: AppContext,
  providerName: string,
  query: { code?: string; state?: string; error?: string },
): Promise<CallbackResult> {
  const { provider, creds } = credentials(ctx, providerName);
  const now = ctx.clock.now();
  const saved = query.state
    ? await ctx.db.get<{ appRedirect: string; keyHash: string | null; expiresAt: number }>('SELECT appRedirect, keyHash, expiresAt FROM oauthStates WHERE state = :state AND provider = :provider', {
        state: query.state,
        provider,
      })
    : undefined;
  if (!saved || saved.expiresAt <= now) {
    return { kind: 'page', status: 400, message: '로그인 요청이 만료됐어요. 앱으로 돌아가 다시 시도해 주세요.' };
  }
  await ctx.db.run('DELETE FROM oauthStates WHERE state = :state', { state: query.state! });

  // 사용자가 취소했거나 동의하지 않음
  if (query.error || !query.code) return { kind: 'redirect', location: withQuery(saved.appRedirect, { error: query.error === 'access_denied' ? 'cancelled' : 'failed' }) };

  let profile;
  try {
    profile = await ctx.providers.social.fetchProfile(provider, creds, { code: query.code, state: query.state!, redirectUri: callbackUrl(ctx, provider) });
  } catch (error) {
    ctx.log.warn(`${provider} 로그인 실패: ${error instanceof SocialAuthError ? error.message : String(error)}`);
    return { kind: 'redirect', location: withQuery(saved.appRedirect, { error: 'failed' }) };
  }

  const { rider, isNew } = await findOrCreateSocialRider(ctx, profile);
  const code = newToken();
  await ctx.db.run('INSERT INTO loginCodes (codeHash, riderId, isNew, keyHash, expiresAt) VALUES (:codeHash, :riderId, :isNew, :keyHash, :expiresAt)', {
    codeHash: sha256(code),
    riderId: rider.id,
    isNew,
    keyHash: saved.keyHash,
    expiresAt: now + LOGIN_CODE_TTL_MS,
  });
  return { kind: 'redirect', location: withQuery(saved.appRedirect, { code }) };
}

/** 1회용 코드 → 로그인 토큰. 같은 코드는 두 번 쓸 수 없고, 로그인을 시작한 앱의 sessionKey 가 있어야 한다. */
export async function exchangeLoginCode(ctx: AppContext, code: string, sessionKey: string): Promise<AuthResponse> {
  // 꺼내면서 지운다(한 문장이라 원자적). 열쇠가 틀려도 지운다 — 가로챈 코드로 열쇠를 맞춰 보는 시도도 한 번뿐
  const row = await ctx.db.get<{ riderId: string; isNew: number; keyHash: string | null; expiresAt: number }>(
    'DELETE FROM loginCodes WHERE codeHash = :codeHash RETURNING riderId, isNew, keyHash, expiresAt',
    { codeHash: sha256(code) },
  );
  if (!row || row.expiresAt <= ctx.clock.now() || !row.keyHash || !safeEqual(row.keyHash, sha256(sessionKey))) {
    throw new ApiError(400, 'invalid_login_code', '로그인이 만료됐어요. 다시 시도해 주세요.');
  }
  return ctx.db.tx(async () => {
    const rider = await getRider(ctx, row.riderId);
    return { token: await issueToken(ctx, rider.id), isNew: row.isNew === 1, onboarded: await isOnboarded(ctx, rider) };
  });
}
