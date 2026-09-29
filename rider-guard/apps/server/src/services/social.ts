/**
 * SNS 제공자와의 통신 (서버측 인가 코드 흐름). 설계 근거는 각 제공자 공식 문서 — 조사·교차검증 결과를 따른다.
 *
 *   앱 → (브라우저) 제공자 로그인 → 제공자가 우리 서버 /auth/oauth/:provider/callback 로 code 전달
 *   → 서버가 code 를 토큰으로 바꾸고(클라이언트 시크릿은 서버에만) 프로필을 읽는다.
 *
 * 카카오·구글은 앱 스킴(riderguard://)을 리다이렉트 주소로 등록할 수 없어서 반드시 서버를 거친다.
 * 구글은 https(또는 localhost)만 등록되므로 휴대폰으로 시험하려면 클라우드 주소가 필요하다.
 */
import type { SocialProvider } from '@rider-guard/contract';

import { externalTimeout, normalizeMobile } from '../lib.ts';
import type { SocialProfile } from './auth.ts';

export type ProviderCredentials = { clientId: string; clientSecret: string };

export interface SocialAuthClient {
  authorizeUrl(provider: SocialProvider, creds: ProviderCredentials, redirectUri: string, state: string): string;
  /** code → 토큰 → 프로필. 실패하면 던진다. */
  fetchProfile(provider: SocialProvider, creds: ProviderCredentials, input: { code: string; state: string; redirectUri: string }): Promise<SocialProfile>;
  /** 탈퇴한 회원의 카카오 연결 끊기 (Admin 키로 서버에서). 이미 끊겨 있으면 성공으로 본다. 실패하면 던진다. */
  unlinkKakao(subject: string, adminKey: string): Promise<void>;
}

const AUTHORIZE: Record<SocialProvider, string> = {
  kakao: 'https://kauth.kakao.com/oauth/authorize',
  naver: 'https://nid.naver.com/oauth2.0/authorize',
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
};

const TOKEN: Record<SocialProvider, string> = {
  kakao: 'https://kauth.kakao.com/oauth/token',
  naver: 'https://nid.naver.com/oauth2.0/token',
  google: 'https://oauth2.googleapis.com/token',
};

const PROFILE: Record<SocialProvider, string> = {
  kakao: 'https://kapi.kakao.com/v2/user/me',
  naver: 'https://openapi.naver.com/v1/nid/me',
  google: 'https://openidconnect.googleapis.com/v1/userinfo',
};

export class SocialAuthError extends Error {}

/** 카카오 회원번호는 2^53 을 넘을 수 있어 JSON.parse 가 숫자를 망가뜨린다 — 파싱 전에 문자열로 감싼다. */
function parseKeepingBigIds(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"')) as Record<string, unknown>;
}

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: externalTimeout(),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new SocialAuthError(`토큰 응답이 JSON 이 아니에요 (${res.status})`);
  }
  // 네이버·카카오는 실패도 200 으로 줄 때가 있다 — 상태 코드가 아니라 error 필드로 판단한다.
  if (!res.ok || json.error || typeof json.access_token !== 'string') {
    throw new SocialAuthError(`토큰 교환 실패: ${String(json.error ?? res.status)} ${String(json.error_description ?? '')}`.trim());
  }
  return json;
}

async function getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: externalTimeout() });
  const text = await res.text();
  if (!res.ok) throw new SocialAuthError(`프로필 조회 실패 (${res.status})`);
  return parseKeepingBigIds(text);
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 제공자 고유 id. 없으면 계정을 만들 수 없다 — "undefined" 같은 id 로 여러 사람이 한 계정에 묶이지 않게 */
function subjectOf(v: unknown): string {
  const id = typeof v === 'number' || typeof v === 'bigint' ? String(v) : str(v);
  if (!id) throw new SocialAuthError('제공자가 사용자 id 를 주지 않았어요.');
  return id;
}

export const httpSocialAuth: SocialAuthClient = {
  authorizeUrl(provider, creds, redirectUri, state) {
    const params = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', state });
    // 카카오·네이버는 받을 항목을 개발자 콘솔의 동의항목/API 설정으로 정한다. 구글만 scope 로 요청한다.
    if (provider === 'google') params.set('scope', 'openid email profile');
    return `${AUTHORIZE[provider]}?${params}`;
  },

  async fetchProfile(provider, creds, { code, state, redirectUri }) {
    const base = { grant_type: 'authorization_code', client_id: creds.clientId, client_secret: creds.clientSecret, code };
    // 카카오·구글은 인가 요청과 같은 redirect_uri 를, 네이버는 state 를 요구한다.
    const token = await postForm(TOKEN[provider], provider === 'naver' ? { ...base, state } : { ...base, redirect_uri: redirectUri });
    const me = await getJson(PROFILE[provider], token.access_token as string);

    if (provider === 'kakao') {
      const account = (me.kakao_account ?? {}) as Record<string, unknown>;
      const profile = (account.profile ?? {}) as Record<string, unknown>;
      return {
        provider,
        subject: subjectOf(me.id),
        // 다른 카카오 계정으로 넘어간 이메일(is_email_valid=false)이나 인증 안 된 이메일은 쓰지 않는다
        email: account.is_email_valid === true && account.is_email_verified === true ? str(account.email) : null,
        // 닉네임을 등록하지 않은 사용자는 기본 문구가 온다
        name: profile.is_default_nickname === true ? null : str(profile.nickname),
        phone: normalizeMobile(str(account.phone_number) ?? ''),
      };
    }
    if (provider === 'naver') {
      if (me.resultcode !== '00') throw new SocialAuthError(`네이버 프로필 조회 실패: ${String(me.message ?? me.resultcode)}`);
      const r = (me.response ?? {}) as Record<string, unknown>;
      return {
        provider,
        subject: subjectOf(r.id),
        email: str(r.email),
        name: str(r.name) ?? str(r.nickname),
        phone: normalizeMobile(str(r.mobile) ?? ''),
      };
    }
    // google — sub 는 29자리까지 가는 문자열. 이메일은 인증된 것만.
    const verified = me.email_verified === true || me.email_verified === 'true';
    return { provider, subject: subjectOf(me.sub), email: verified ? str(me.email) : null, name: str(me.name), phone: null };
  },

  async unlinkKakao(subject, adminKey) {
    const res = await fetch('https://kapi.kakao.com/v1/user/unlink', {
      method: 'POST',
      headers: { authorization: `KakaoAK ${adminKey}`, 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({ target_id_type: 'user_id', target_id: subject }),
      signal: externalTimeout(),
    });
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    // -101: 이 앱과 연결되지 않은 사용자 — 사용자가 카카오 쪽에서 이미 끊었다
    if (body.code === -101) return;
    throw new SocialAuthError(`카카오 연결 끊기 실패 (${res.status} ${body.code ?? ''} ${body.msg ?? ''})`.trim());
  },
};
