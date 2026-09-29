import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { api, getApiToken, setApiToken, setUnauthorizedHandler } from '@/api/client';
import { stopLocationTracking } from '@/features/location';
import { unregisterPush } from '@/features/push';
import { clearPendingName } from '@/features/sim';
import { resetTo } from '@/lib/nav';
import { KEYS, storage } from '@/lib/storage';

const tokenStore = { get: () => storage.get(KEYS.token), set: (v: string | null) => storage.set(KEYS.token, v) };

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';
type SignOutOptions = { /** 토큰이 이미 무효(만료·탈퇴)라 서버 정리를 건너뛴다 */ tokenInvalid?: boolean };
type AuthValue = { status: AuthStatus; signIn(token: string): void; signOut(options?: SignOutOptions): void };

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    tokenStore
      .get()
      // 읽지 못하면(키스토어 손상 등) 스플래시에 멈추지 않고 로그인 화면으로
      .catch(() => null)
      .then((token) => {
        setApiToken(token);
        setStatus(token ? 'signedIn' : 'signedOut');
        // 예전 옵션(iOS 잠금 중 읽기 불가)으로 저장된 토큰을 지금 옵션으로 다시 저장한다
        if (token && Platform.OS === 'ios') void tokenStore.set(token).catch(() => undefined);
      });
  }, []);

  const signIn = useCallback((token: string) => {
    setApiToken(token);
    setStatus('signedIn');
    void tokenStore.set(token);
  }, []);

  const signOut = useCallback(({ tokenInvalid = false }: SignOutOptions = {}) => {
    // 토큰은 바로 비운다 — 곧바로 다시 로그인해도 정리 요청이 새 토큰을 건드리지 않게
    const token = tokenInvalid ? null : getApiToken();
    setApiToken(null);
    // 다른 사람 사고 알림이 이 폰에 오지 않게 푸시를 해제한 뒤 서버에서 토큰을 폐기한다 (폐기 뒤에는 해제할 수 없다)
    void unregisterPush(token).then(() => token && api('POST', '/auth/logout', undefined, { token }).catch(() => undefined));
    // 위치 수집도 멈춘다
    void stopLocationTracking();
    // 가입 화면에서 받아 둔 이름은 그 계정 것 — 같은 기기로 다른 계정에 들어가 시작·동의를 마쳐도 섞이지 않게
    clearPendingName();
    queryClient.clear();
    setStatus('signedOut');
    void tokenStore.set(null);
    resetTo('/');
  }, [queryClient]);

  // 토큰이 만료·폐기되면 어느 화면에서든 로그인으로 돌려보낸다.
  useEffect(() => {
    setUnauthorizedHandler(() => signOut({ tokenInvalid: true }));
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
