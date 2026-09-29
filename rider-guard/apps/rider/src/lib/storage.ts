import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * 작은 문자열 보관소. 네이티브는 키체인/키스토어, 웹은 localStorage (SecureStore 가 웹을 지원하지 않는다).
 * 백그라운드 위치 작업은 화면(React) 없이 돌 수 있어서 로그인 토큰·진행 중 세션을 여기서 다시 읽는다.
 */
export const KEYS = {
  token: 'rider-guard.token',
  session: 'rider-guard.session',
  /** 진행 중인 SNS 로그인의 sessionKey — 브라우저에 가 있는 동안 앱 프로세스가 죽어도 이어서 마치려고 저장한다 */
  oauth: 'rider-guard.oauth',
} as const;

/**
 * iOS 키체인 기본값(잠금 해제 중에만 읽힘)이면 화면이 꺼진 채 운행할 때 백그라운드 위치 작업이 토큰을 못 읽는다.
 * 재부팅 뒤 한 번 잠금을 풀면 계속 읽히게 한다. 안드로이드는 이 옵션을 쓰지 않는다.
 */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS !== 'web') return SecureStore.getItemAsync(key);
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string | null) {
    if (Platform.OS !== 'web') {
      if (!value) return SecureStore.deleteItemAsync(key, SECURE_OPTIONS);
      // iOS 는 같은 키가 이미 있으면 값만 바꾸고 접근성은 옛것(잠금 해제 중에만)으로 남긴다 — 지우고 새로 넣는다.
      // 두 호출 사이에 앱이 죽으면 값이 사라질 수 있다(토큰이면 다시 로그인) — 잠긴 채 못 읽는 것보다 낫다.
      if (Platform.OS === 'ios') await SecureStore.deleteItemAsync(key, SECURE_OPTIONS);
      await SecureStore.setItemAsync(key, value, SECURE_OPTIONS);
      return;
    }
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* 저장 못 해도 이번 실행 동안은 메모리 상태로 동작 */
    }
  },
};
