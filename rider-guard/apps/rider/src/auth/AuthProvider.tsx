import { useQueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { setApiToken, setUnauthorizedHandler } from '@/api/client';
import { resetTo } from '@/lib/nav';

const KEY = 'rider-guard.token';

/** 네이티브는 키체인/키스토어, 웹은 localStorage (SecureStore 가 웹을 지원하지 않는다) */
const tokenStore = {
  async get(): Promise<string | null> {
    if (Platform.OS !== 'web') return SecureStore.getItemAsync(KEY);
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  async set(value: string | null) {
    if (Platform.OS !== 'web') {
      await (value ? SecureStore.setItemAsync(KEY, value) : SecureStore.deleteItemAsync(KEY));
      return;
    }
    try {
      if (value) localStorage.setItem(KEY, value);
      else localStorage.removeItem(KEY);
    } catch {
      /* 저장 못 해도 이번 실행 동안은 로그인 상태 유지 */
    }
  },
};

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';
type AuthValue = { status: AuthStatus; signIn(token: string): void; signOut(): void };

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    tokenStore.get().then((token) => {
      setApiToken(token);
      setStatus(token ? 'signedIn' : 'signedOut');
    });
  }, []);

  const signIn = useCallback((token: string) => {
    setApiToken(token);
    setStatus('signedIn');
    void tokenStore.set(token);
  }, []);

  const signOut = useCallback(() => {
    setApiToken(null);
    queryClient.clear();
    setStatus('signedOut');
    void tokenStore.set(null);
    resetTo('/');
  }, [queryClient]);

  // 토큰이 만료·폐기되면 어느 화면에서든 로그인으로 돌려보낸다.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const value = useMemo(() => ({ status, signIn, signOut }), [status, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있어요.');
  return value;
}
