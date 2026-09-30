import type { IncidentDetailDto, PushData } from '@rider-guard/contract';
import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { api } from '@/api/client';
import { applyIncident, isOpenStatus, useActiveIncident, useMe } from '@/api/hooks';
import { useAutoProtection } from '@/features/helmet';
import { useLocationTracking } from '@/features/location';
import { usePhoneSensor } from '@/features/phoneSensor';
import { pushSupported, registerPush } from '@/features/push';
import { resetTo } from '@/lib/nav';

/** 폴링과 알림 탭이 동시에 와도 확인 화면은 한 번만 */
let presentedIncident: string | null = null;
function presentAlert(id: string, pathname: string) {
  if (presentedIncident === id || pathname === '/alert') return;
  presentedIncident = id;
  router.push({ pathname: '/alert', params: { id } });
}

/**
 * 로그인 상태에서 항상 떠 있는 백그라운드 역할:
 * - 헬멧 착용(시뮬레이션)에 맞춰 보호(운행 세션)를 자동으로 켜고 끈다 — features/helmet
 * - 보호 중 위치 수집 (앱을 닫아도 — 개발 빌드)
 * - 헬멧 기기가 없으면 휴대폰 자체 센서로 충격 감지 — features/phoneSensor
 * - 푸시 토큰 등록, 알림을 눌러 들어온 경우 처리
 * - 사고가 감지되면(휴대폰·태그·지표 판정 어느 쪽이든) 어느 화면에 있든 사고 확인 화면을 띄운다
 */
export function SessionServices() {
  const { data: me } = useMe();
  const sessionId = me?.session?.id ?? null;
  useLocationTracking(sessionId);
  // 헬멧 기기가 없으면 휴대폰 가속도계·자이로를 감지 센서로
  usePhoneSensor(sessionId, me?.device);

  useEffect(() => {
    void registerPush();
  }, []);

  const { data } = useActiveIncident(!!sessionId);
  // 진행 중 사고를 아직 받아 보지 못했으면 null — 그동안은 헬멧을 벗어도 보호를 끄지 않는다
  useAutoProtection(data === undefined ? null : isOpenStatus(data.incident?.status));
  const pathname = usePathname();
  useEffect(() => {
    const incident = data?.incident;
    if (incident?.status === 'countdown') presentAlert(incident.id, pathname);
  }, [data, pathname]);

  return pushSupported ? <NotificationResponder /> : null;
}

/** 알림(또는 잠금화면 버튼)을 눌러 앱이 열렸을 때. 앱이 꺼져 있었어도 마지막 응답이 여기로 온다. */
function NotificationResponder() {
  const response = Notifications.useLastNotificationResponse();
  const qc = useQueryClient();
  const pathname = usePathname();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!response) return;
    const data = response.notification.request.content.data as Partial<PushData> | undefined;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    if (!data?.incidentId || handled.current === key) return;
    handled.current = key;
    Notifications.clearLastNotificationResponse();
    const id = data.incidentId;

    const action = response.actionIdentifier;
    if (action === 'ok' || action === 'help') {
      // 잠금화면 버튼 — 화면을 거치지 않고 바로 응답한다 (설계문서 4.3)
      api<IncidentDetailDto>('POST', `/me/incidents/${id}/respond`, { response: action })
        .then((incident) => {
          applyIncident(qc, incident);
          if (action === 'help') router.push({ pathname: '/status', params: { id } });
          else resetTo('/home');
        })
        .catch(() => presentAlert(id, pathname)); // 이미 끝난 사고거나 네트워크 문제 — 화면에서 다시 고르게
    } else if (data.type === 'status') {
      router.push({ pathname: '/status', params: { id } });
    } else {
      presentAlert(id, pathname);
    }
  }, [response, qc, pathname]);

  return null;
}
