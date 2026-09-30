import type { ApiErrorBody } from '@rider-guard/contract';
import Constants from 'expo-constants';

/**
 * API 서버 주소. EXPO_PUBLIC_API_URL 이 있으면 그것을 쓰고, 없으면 개발 중에는 Metro 를 띄운 PC 의 IP 로
 * 같은 Wi-Fi 의 실기기(Expo Go)에서도 붙을 수 있게 한다.
 */
export const API_URL = (() => {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host || 'localhost'}:4000`;
})();

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let token: string | null = null;
let onUnauthorized: ((failedToken: string) => void) | null = null;

export const setApiToken = (value: string | null) => {
  token = value;
};
export const getApiToken = () => token;
export const setUnauthorizedHandler = (fn: ((failedToken: string) => void) | null) => {
  onUnauthorized = fn;
};

/** options.token: 지금 로그인 토큰 대신 이 토큰으로 (로그아웃 뒤 정리 요청). 이때는 401 이 나도 로그아웃 처리를 하지 않는다. */
export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options: { token?: string; timeoutMs?: number } = {},
): Promise<T> {
  const auth = options.token ?? token;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new ApiError(0, 'network', '서버에 연결할 수 없어요. 네트워크를 확인해 주세요.');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!res.ok) {
    if (res.status === 401 && !options.token && auth && token === auth) onUnauthorized?.(auth);
    throw new ApiError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `요청에 실패했어요 (${res.status})`);
  }
  return json as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : '알 수 없는 오류가 발생했어요.');
