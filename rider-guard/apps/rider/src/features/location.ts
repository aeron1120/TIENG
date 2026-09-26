import type { LocationPoint } from '@rider-guard/contract';
import * as Location from 'expo-location';
import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/api/client';

type LocationState = { permission: 'unknown' | 'granted' | 'denied'; last: LocationPoint | null };

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

const FLUSH_MS = 15_000;
const MAX_BUFFER = 2000;

/**
 * 운행 세션 동안만 위치를 모은다 (2.1 — 세션 밖에서는 수집 자체를 하지 않는다).
 * 20m 이상 움직였을 때만 기록하므로 정차 중에는 자연히 기록이 줄어든다 (4.1.5).
 * 전송 실패분은 메모리에 쌓아 두었다가 다음 주기에 한꺼번에 보낸다 (4.1.4).
 * TODO: 앱이 백그라운드일 때 수집하려면 개발 빌드 + 백그라운드 위치 권한이 필요하다.
 */
export function useLocationTracking(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    const buffer: LocationPoint[] = [];

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      setState({ permission: status === 'granted' ? 'granted' : 'denied' });
      if (status !== 'granted') return;
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5_000, distanceInterval: 20 },
        (pos) => {
          const point: LocationPoint = {
            recordedAt: new Date(pos.timestamp).toISOString(),
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? undefined,
            speed: pos.coords.speed ?? undefined,
            heading: pos.coords.heading ?? undefined,
          };
          buffer.push(point);
          if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
          setState({ last: point });
        },
      );
      if (cancelled) sub.remove();
      else subscription = sub;
    })().catch(() => setState({ permission: 'denied' }));

    const flush = async () => {
      if (!buffer.length) return;
      const batch = buffer.splice(0, 500);
      try {
        await api('POST', `/me/sessions/${sessionId}/locations`, { points: batch });
      } catch {
        buffer.unshift(...batch);
      }
    };
    const timer = setInterval(flush, FLUSH_MS);

    return () => {
      cancelled = true;
      subscription?.remove();
      clearInterval(timer);
      void flush(); // 종료 직전 남은 위치도 보낸다 — 세션 기간 안의 점이라 서버가 받는다
    };
  }, [sessionId]);
}
