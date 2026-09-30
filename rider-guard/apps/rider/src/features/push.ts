import type { PushAction, PushData, PushTokenRequest } from '@rider-guard/contract';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { api } from '@/api/client';

/**
 * 앱이 꺼져 있거나 백그라운드일 때 사고 확인을 띄우는 경로. 서버가 사고를 열면 Expo 푸시로 보낸다.
 * 원격 푸시는 Expo Go 에서 동작하지 않는다 — 개발 빌드가 필요하다 (README '휴대폰 빌드').
 */

export const PUSH_CHANNEL = 'incident'; // 서버 services/push.ts 와 같은 이름
const PUSH_CATEGORY = 'incident';
export const PUSH_ACTIONS: PushAction[] = ['help', 'ok'];

export const pushSupported = Platform.OS !== 'web';
const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export type PushStatus = 'unknown' | 'unsupported' | 'expo_go' | 'simulator' | 'no_project' | 'denied' | 'registered' | 'error';
let status: PushStatus = pushSupported ? 'unknown' : 'unsupported';
let registeredToken: string | null = null;
const listeners = new Set<() => void>();
const setStatus = (next: PushStatus) => {
  status = next;
  listeners.forEach((l) => l());
};
export const usePushStatus = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );

if (pushSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      // 앱이 켜져 있으면 사고 확인 화면이 폴링으로 먼저 뜬다 — 같은 내용을 배너로 겹쳐 띄우지 않는다.
      const quiet = (notification.request.content.data as Partial<PushData> | undefined)?.type === 'incident';
      return { shouldShowBanner: !quiet, shouldShowList: true, shouldPlaySound: !quiet, shouldSetBadge: false };
    },
  });
}

/** 안드로이드 채널과 잠금화면 버튼. 권한 요청보다 먼저 만들어야 한다 (Android 13+). */
async function setupChannels() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL, {
      name: '사고 확인',
      description: '사고가 감지되면 괜찮은지 묻고, 비상연락 시작을 알려요.',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 700, 500, 700, 500, 700],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      sound: 'default',
    });
  }
  // 장갑 낀 손으로 잠금화면에서 바로 누를 수 있게 (설계문서 4.3). 누르면 앱이 열리며 응답을 보낸다.
  await Notifications.setNotificationCategoryAsync(PUSH_CATEGORY, [
    { identifier: 'help', buttonTitle: '도움이 필요해요', options: { opensAppToForeground: true } },
    { identifier: 'ok', buttonTitle: '괜찮아요', options: { opensAppToForeground: true } },
  ]);
}

/** 로그인 상태에서 한 번 부른다. 토큰은 바뀔 수 있으니 매 실행마다 다시 등록한다. */
export async function registerPush(): Promise<void> {
  if (!pushSupported) return;
  if (inExpoGo) return setStatus('expo_go');
  if (!Device.isDevice) return setStatus('simulator');
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return setStatus('no_project');
  try {
    await setupChannels();
    let { status: permission } = await Notifications.getPermissionsAsync();
    if (permission !== 'granted') permission = (await Notifications.requestPermissionsAsync()).status;
    if (permission !== 'granted') return setStatus('denied');
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    const body: PushTokenRequest = { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' };
    await api('PUT', '/me/push-token', body);
    registeredToken = token;
    setStatus('registered');
  } catch (error) {
    console.warn('푸시 등록 실패', error);
    setStatus('error');
  }
}

/**
 * 로그아웃 때 — 다른 사람의 사고 알림이 이 폰에 오지 않게.
 * authToken 은 로그아웃하는 계정의 토큰. null 이면 토큰이 이미 무효(만료·탈퇴)라 서버 정리는 건너뛴다.
 */
export async function unregisterPush(authToken: string | null) {
  const token = registeredToken;
  registeredToken = null;
  if (token && authToken) await api('DELETE', `/me/push-token/${encodeURIComponent(token)}`, undefined, { token: authToken }).catch(() => undefined);
  if (pushSupported) setStatus('unknown');
}

export const PUSH_STATUS_TEXT: Record<PushStatus, string> = {
  unknown: '확인 중',
  unsupported: '웹에서는 지원하지 않아요',
  expo_go: 'Expo Go 에서는 안 돼요 — 개발 빌드에서 켜져요',
  simulator: '에뮬레이터에서는 받을 수 없어요',
  no_project: 'EAS 프로젝트가 연결되지 않았어요 (eas init)',
  denied: '알림 권한이 꺼져 있어요 — 설정에서 켜 주세요',
  registered: '켜짐',
  error: '등록하지 못했어요',
};
