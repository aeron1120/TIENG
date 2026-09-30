import type { LocationPoint, UploadLocationsResponse } from '@rider-guard/contract';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Alert, Platform } from 'react-native';

import { API_URL } from '@/api/client';
import { simPosition, type SimPosition } from '@/features/sim';
import { KEYS, storage } from '@/lib/storage';
import { colors } from '@/theme';

/**
 * 보호 중 위치 수집. 운행 세션(= 헬멧을 쓰고 있는 동안의 보호) 동안만 켠다 (설계문서 2.1 — 세션 밖에서는 수집 자체를 하지 않는다).
 *
 *   background  앱을 닫아도 계속 — 안드로이드는 '보호 중' 상시 알림(포그라운드 서비스, v3·6), iOS 는 상단 위치 표시가 뜬다.
 *               보이지 않는 추적은 '감시 도구'로 느껴지므로 일부러 드러낸다.
 *   foreground  백그라운드 권한을 안 줬거나 Expo Go·웹 — 앱을 켜 둔 동안만
 *
 * 20m 이상 움직였을 때만 기록하므로 정차 중에는 기록이 자연히 줄어든다 (4.1.5 배터리).
 */

export const LOCATION_TASK = 'rider-guard-location';
const backgroundCapable = Platform.OS !== 'web' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

type Permission = 'unknown' | 'background' | 'foreground' | 'denied';
type LocationState = { permission: Permission; last: LocationPoint | null };

let state: LocationState = { permission: 'unknown', last: null };
const listeners = new Set<() => void>();
const setState = (patch: Partial<LocationState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const useLocationState = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

/** 사고 감지 이벤트에 붙일 최근 위치 (2분 이내) */
export function recentLocation() {
  const last = state.last;
  if (!last || Date.now() - Date.parse(last.recordedAt) > 120_000) return undefined;
  return { lat: last.lat, lng: last.lng, accuracy: last.accuracy };
}

/**
 * 지도 가운데에 둘 위치 — 보호 중 모은 마지막 위치, 없으면 서울 기본 좌표(시뮬레이션, 역삼역).
 * const pos = useRiderPosition(); <RiderMap location={pos} … />  — pos.simulated 면 시뮬레이션 위치.
 */
export function useRiderPosition(): SimPosition {
  const { last } = useLocationState();
  return useMemo(() => simPosition(last ? { lat: last.lat, lng: last.lng, accuracy: last.accuracy ?? null, recordedAt: last.recordedAt } : null), [last]);
}

const toPoint = (pos: Location.LocationObject): LocationPoint => ({
  recordedAt: new Date(pos.timestamp).toISOString(),
  lat: pos.coords.latitude,
  lng: pos.coords.longitude,
  accuracy: pos.coords.accuracy ?? undefined,
  speed: pos.coords.speed ?? undefined,
  heading: pos.coords.heading ?? undefined,
});

// ── 업로드 (화면·백그라운드 공용) ──────────────────────────────

const MAX_BUFFER = 2000;
const buffer: LocationPoint[] = [];

/**
 * 모아 둔 위치를 보낸다. 백그라운드 작업은 React 없이 돌 수 있어 토큰·세션을 저장소에서 다시 읽는다.
 * 실패분은 다음에 다시 보낸다 (4.1.4). 프로세스가 죽으면 메모리 버퍼는 사라진다 — MVP 한계.
 * 서버가 모두 거절하면(세션이 끝남) 수집을 멈춘다 — 앱이 꺼진 채 자동 종료된 세션을 계속 따라가지 않게.
 */
async function flush() {
  if (!buffer.length) return;
  let token: string | null;
  let sessionId: string | null;
  try {
    [token, sessionId] = await Promise.all([storage.get(KEYS.token), storage.get(KEYS.session)]);
  } catch {
    return; // 저장소를 잠시 못 읽는다(기기 잠김 등) — 버퍼에 둔 채 다음에 다시
  }
  if (!token || !sessionId) {
    buffer.length = 0;
    return stopLocationTracking();
  }
  const batch = buffer.splice(0, 500);
  try {
    const res = await fetch(`${API_URL}/me/sessions/${sessionId}/locations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ points: batch }),
    });
    if (res.status === 401 || res.status === 404) return stopLocationTracking();
    if (!res.ok) throw new Error(String(res.status));
    const result = (await res.json()) as UploadLocationsResponse;
    if (result.accepted === 0 && result.rejected > 0) await stopLocationTracking();
  } catch {
    buffer.unshift(...batch);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  }
}

function collect(points: LocationPoint[]) {
  if (!points.length) return;
  buffer.push(...points);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  setState({ last: points.at(-1)! });
}

// 전역에서 정의해야 한다 — 앱이 닫혀 있을 때 화면 없이 JS 만 떠서 이 작업을 부른다.
if (backgroundCapable) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    collect(data.locations.map(toPoint));
    await flush();
  });
}

// ── 시작 · 종료 ────────────────────────────────────────────────

/** 한 번 실행에 한 번만 묻는다 — 보호가 켜질 때마다 설정 화면으로 보내면 앱을 끈다. */
let askedThisRun = false;

/**
 * 안드로이드 11+ 는 백그라운드 권한을 요청하면 곧바로 설정 화면으로 넘어간다. 왜 필요한지 먼저 말한다
 * (Google Play 의 백그라운드 위치 '명시적 고지' 요건이기도 하다).
 */
function explainBackground(): Promise<boolean> {
  if (Platform.OS !== 'android') return Promise.resolve(true);
  return new Promise((resolve) =>
    Alert.alert(
      '위치 "항상 허용"이 필요해요',
      '앱을 닫아 두어도 사고를 감지하고 비상연락처에 위치를 알리려면, 다음 화면에서 "항상 허용"을 골라 주세요.\n\n헬멧을 쓰고 있는 동안에만 수집하고, 헬멧을 벗으면 멈춰요.',
      [
        { text: '나중에', style: 'cancel', onPress: () => resolve(false) },
        { text: '설정으로', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    ),
  );
}

async function startBackground(): Promise<boolean> {
  let { status } = await Location.getBackgroundPermissionsAsync();
  if (status !== 'granted') {
    if (askedThisRun) return false;
    askedThisRun = true;
    if (!(await explainBackground())) return false;
    ({ status } = await Location.requestBackgroundPermissionsAsync());
  }
  if (status !== 'granted') return false;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return true;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 5_000,
    distanceInterval: 20,
    // 한 번에 몰아서 받아 깨어나는 횟수를 줄인다
    deferredUpdatesInterval: 15_000,
    // v3·6 잠금화면 상시 알림 — '보호 중' / '헬멧 연결됨, 앱을 닫아도 계속 보호돼요'
    foregroundService: {
      notificationTitle: '보호 중',
      notificationBody: '헬멧 연결됨, 앱을 닫아도 계속 보호돼요',
      notificationColor: colors.asphalt,
      killServiceOnDestroy: false,
    },
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.OtherNavigation,
    showsBackgroundLocationIndicator: true,
  });
  return true;
}

/** 보호가 꺼질 때(헬멧을 벗음)·로그아웃 때. 여러 번 불려도 된다. */
export async function stopLocationTracking() {
  await storage.set(KEYS.session, null);
  if (backgroundCapable && (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

const FLUSH_MS = 15_000;

export function useLocationTracking(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) {
      void stopLocationTracking();
      return;
    }
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      await storage.set(KEYS.session, sessionId);
      const fg = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (fg.status !== 'granted') return setState({ permission: 'denied' });
      if (backgroundCapable && (await startBackground())) return setState({ permission: 'background' });

      // 백그라운드를 쓸 수 없으면 앱을 켜 둔 동안만
      setState({ permission: 'foreground' });
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5_000, distanceInterval: 20 },
        (pos) => collect([toPoint(pos)]),
      );
      if (cancelled) sub.remove();
      else subscription = sub;
    })().catch(() => setState({ permission: 'denied' }));

    // 백그라운드 작업은 들어올 때마다 스스로 보내고, 이 타이머는 전경 수집분과 실패분을 보낸다.
    const timer = setInterval(() => void flush(), FLUSH_MS);
    return () => {
      cancelled = true;
      subscription?.remove();
      clearInterval(timer);
      void flush();
    };
  }, [sessionId]);
}
