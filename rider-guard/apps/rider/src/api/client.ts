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
let onUnauthorized: (() => void) | null = null;

export const setApiToken = (value: string | null) => {
  token = value;
};
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', '서버에 연결할 수 없어요. 네트워크를 확인해 주세요.');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `요청에 실패했어요 (${res.status})`);
  }
  return json as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : '알 수 없는 오류가 발생했어요.');
