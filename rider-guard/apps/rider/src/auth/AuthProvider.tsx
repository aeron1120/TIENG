import type { MeDto } from '@rider-guard/contract';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { api, ApiError, getApiToken, setApiToken, setUnauthorizedHandler } from '@/api/client';
import { stopLocationTracking } from '@/features/location';
import { unregisterPush } from '@/features/push';
import { clearPendingName } from '@/features/sim';
import { resetTo } from '@/lib/nav';
import { authTokenStore, KEYS } from '@/lib/storage';

type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'error';
type SignOutOptions = { tokenInvalid?: boolean; expectedToken?: string };
type AuthValue = {
  status: AuthStatus;
  restoreError: string | null;
  retryRestore(): Promise<void>;
  signIn(token: string): Promise<void>;
  signOut(options?: SignOutOptions): void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const generation = useRef(0);
  const storedToken = useRef<string | null>(null);
  const pendingToken = useRef<string | null>(null);

  const clearUserData = useCallback(() => {
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  const restore = useCallback(async () => {
    const current = ++generation.current;
    pendingToken.current = null;
    setStatus('loading');
    setRestoreError(null);
    setApiToken(null);
    clearUserData();
    let candidate: string | null;
    try {
      candidate = await authTokenStore.get();
    } catch {
      if (current === generation.current) {
        setRestoreError('저장된 로그인 정보를 읽을 수 없어요. 다시 시도해 주세요.');
        setStatus('error');
      }
      return;
    }
    if (current !== generation.current) return;
    storedToken.current = candidate;
    if (!candidate) {
      setStatus('signedOut');
      return;
    }
    try {
      // A stored token is only a claim. No private query runs until the server accepts it.
      // 45s covers a Render cold start (~30s observed); a shorter limit turned a sleeping server into a false "offline" error.
      await api<MeDto>('GET', '/me', undefined, { token: candidate, timeoutMs: 45_000 });
      if (current !== generation.current) return;
      if (await authTokenStore.get() !== candidate) {
        setRestoreError('로그인 상태가 변경됐어요. 다시 확인해 주세요.');
        setStatus('error');
        return;
      }
      setApiToken(candidate);
      setStatus('signedIn');
    } catch (error) {
      if (current !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) {
        const cleared = await authTokenStore.clearIfCurrent(candidate);
        if (current !== generation.current) return;
        if (!cleared) {
          setRestoreError('로그인 상태가 변경됐어요. 다시 확인해 주세요.');
          setStatus('error');
          return;
        }
        storedToken.current = null;
        setStatus('signedOut');
        return;
      }
      setRestoreError('서버에 연결할 수 없어요. 네트워크를 확인하고 다시 시도해 주세요.');
      setStatus('error');
    }
  }, [clearUserData]);

  useEffect(() => {
    const start = setTimeout(() => void restore(), 0);
    if (Platform.OS !== 'web') return () => clearTimeout(start);
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEYS.token && event.newValue !== storedToken.current) void restore();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      clearTimeout(start);
      window.removeEventListener('storage', onStorage);
    };
  }, [restore]);

  const signIn = useCallback(async (token: string) => {
    const current = ++generation.current;
    pendingToken.current = token;
    setStatus('loading');
    setRestoreError(null);
    setApiToken(null);
    clearUserData();
    try {
      await authTokenStore.set(token);
    } catch {
      if (current === generation.current) {
        setRestoreError('로그인 정보를 저장할 수 없어요. 다시 시도해 주세요.');
        setStatus('error');
      }
      throw new Error('로그인 정보를 저장할 수 없어요. 다시 시도해 주세요.');
    }
    if (current !== generation.current) {
      await authTokenStore.clearIfCurrent(token);
      return;
    }
    pendingToken.current = null;
    storedToken.current = token;
    setApiToken(token);
    setStatus('signedIn');
  }, [clearUserData]);

  const signOut = useCallback(({ tokenInvalid = false, expectedToken }: SignOutOptions = {}) => {
    const token = getApiToken() ?? pendingToken.current ?? storedToken.current;
    if (expectedToken && token !== expectedToken) return;
    ++generation.current;
    pendingToken.current = null;
    storedToken.current = null;
    setApiToken(null);
    clearUserData();
    setRestoreError(null);
    setStatus('signedOut');
    if (token) {
      void authTokenStore.clearIfCurrent(token);
      if (!tokenInvalid) void unregisterPush(token).catch(() => undefined).then(() => api('POST', '/auth/logout', undefined, { token }).catch(() => undefined));
    }
    void stopLocationTracking();
    clearPendingName();
    resetTo('/');
  }, [clearUserData]);

  useEffect(() => {
    setUnauthorizedHandler((failedToken) => signOut({ tokenInvalid: true, expectedToken: failedToken }));
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const value = useMemo(() => ({ status, restoreError, retryRestore: restore, signIn, signOut }), [status, restoreError, restore, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있어요.');
  return value;
}
