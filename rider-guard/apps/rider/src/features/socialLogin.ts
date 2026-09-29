import type { AuthResponse, OAuthStartResponse, SocialProvider } from '@rider-guard/contract';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { api, ApiError } from '@/api/client';
import { KEYS, storage } from '@/lib/storage';

/**
 * SNS 로그인 (서버측 인가 코드 흐름 — 서버 services/oauth.ts 참고)
 *   1. 서버에 시작 요청 → 제공자 로그인 주소 + sessionKey
 *   2. 시스템 브라우저로 로그인 (안드로이드 Custom Tabs, iOS 인증 세션) — 앱 안 WebView 는 구글이 막는다
 *   3. 서버가 riderguard://auth/callback?code=… 로 돌려보냄 → 1회용 코드 + sessionKey 로 로그인 토큰 교환
 *
 * sessionKey 는 이 앱이 시작한 로그인의 코드만 교환되게 한다(가로챈 코드·심은 코드 방지). 브라우저에 가 있는 동안
 * 안드로이드가 앱 프로세스를 정리해도 이어서 마치도록 저장소에 둔다.
 * 안드로이드는 같은 복귀가 두 번 온다 — 브라우저 결과와, 딥링크로 열린 /auth/callback 화면. 한 코드는 한 번만 교환한다.
 */

/** 웹: 이 창이 로그인 팝업이면 결과를 연 창에 넘긴다(연 창이 팝업을 닫는다). 이 창에서는 교환하지 않는다. */
export const isAuthPopup = (() => {
  try {
    return WebBrowser.maybeCompleteAuthSession().type === 'success';
  } catch {
    return false;
  }
})();

export type SocialResult = { kind: 'ok'; auth: AuthResponse } | { kind: 'cancelled' } | { kind: 'handled' };

/**
 * 로그인 후 돌아올 앱 주소. Linking.createURL 은 개발 빌드에서 Metro 주소를 끼워 넣어(riderguard://192.168…:8081auth/callback)
 * 라우터가 못 알아보므로 직접 만든다.
 */
function redirectUri() {
  if (Platform.OS === 'web') return `${window.location.origin}/auth/callback`;
  if (Constants.executionEnvironment === 'storeClient') return Linking.createURL('auth/callback'); // Expo Go: exp://…/--/auth/callback
  const scheme = Constants.expoConfig?.scheme;
  return `${Array.isArray(scheme) ? scheme[0] : (scheme ?? 'riderguard')}://auth/callback`;
}

/** 서버 state 유효 시간과 같다 — 그보다 오래된 로그인은 서버에서도 끝났다 */
const PENDING_TTL_MS = 10 * 60_000;
type Pending = { sessionKey: string; startedAt: number };

/** 진행 중인 로그인의 sessionKey 를 꺼내면서 지운다 (한 번만 쓴다) */
async function takePending(): Promise<Pending | null> {
  const raw = await storage.get(KEYS.oauth).catch(() => null);
  await storage.set(KEYS.oauth, null).catch(() => undefined);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as Pending;
    return Date.now() - pending.startedAt <= PENDING_TTL_MS ? pending : null;
  } catch {
    return null;
  }
}

const exchanged = new Set<string>();

export async function loginWithSocial(provider: SocialProvider): Promise<SocialResult> {
  const uri = redirectUri();
  const { authorizeUrl, sessionKey } = await api<OAuthStartResponse>('POST', `/auth/oauth/${provider}/start`, { redirectUri: uri });
  await storage.set(KEYS.oauth, JSON.stringify({ sessionKey, startedAt: Date.now() } satisfies Pending));
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, uri);
  // 안드로이드는 딥링크보다 '앱으로 돌아옴'을 먼저 알아채 dismiss 로 끝나기도 한다 — 그때는 /auth/callback 화면이 마무리하므로
  // sessionKey 를 지우지 않는다. 남은 키로는 이 로그인의 코드만 바꿀 수 있고, 10분 뒤에는 쓰지 않는다.
  if (result.type !== 'success') return { kind: 'cancelled' };
  return completeSocialLogin(Linking.parse(result.url).queryParams ?? {});
}

type CallbackParams = { code?: string | string[]; error?: string | string[] };

/** 서버가 돌려보낸 주소의 code 또는 error 를 처리한다. /auth/callback 화면도 이걸 부른다. */
export async function completeSocialLogin(params: CallbackParams): Promise<SocialResult> {
  const error = typeof params.error === 'string' ? params.error : null;
  const code = typeof params.code === 'string' ? params.code : null;
  if (error || !code) {
    await storage.set(KEYS.oauth, null).catch(() => undefined);
    if (error === 'cancelled') return { kind: 'cancelled' };
    throw new ApiError(400, 'social_failed', error ? 'SNS 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.' : 'SNS 로그인 응답이 올바르지 않아요.');
  }
  // 저장소를 읽기(비동기) 전에 표시한다 — 같은 코드가 두 경로로 거의 동시에 온다
  if (exchanged.has(code)) return { kind: 'handled' };
  exchanged.add(code);
  const pending = await takePending();
  if (!pending) throw new ApiError(400, 'login_expired', '로그인 요청이 만료됐어요. 로그인 화면에서 다시 시도해 주세요.');
  return { kind: 'ok', auth: await api<AuthResponse>('POST', '/auth/oauth/exchange', { code, sessionKey: pending.sessionKey }) };
}
