import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useActiveIncident, useMe } from '@/api/hooks';
import { useLocationTracking } from '@/features/location';

/**
 * 로그인 상태에서 항상 떠 있는 백그라운드 역할:
 * - 운행 중 위치 수집
 * - 사고가 감지되면(휴대폰·태그·detector 어느 쪽이든) 어느 화면에 있든 사고 확인 화면을 띄운다
 * TODO: 앱이 꺼져 있을 때도 알리려면 푸시 알림(개발 빌드)이 필요하다. 그 경우에도 에스컬레이션은 서버가 진행한다.
 */
export function SessionServices() {
  const { data: me } = useMe();
  const sessionId = me?.session?.id ?? null;
  useLocationTracking(sessionId);

  const { data } = useActiveIncident(!!sessionId);
  const pathname = usePathname();
  const presented = useRef<string | null>(null);

  useEffect(() => {
    const incident = data?.incident;
    if (incident?.status !== 'countdown' || presented.current === incident.id || pathname === '/alert') return;
    presented.current = incident.id;
    router.push({ pathname: '/alert', params: { id: incident.id } });
  }, [data, pathname]);

  return null;
}
