import { externalTimeout } from './lib.ts';
import { httpSocialAuth, type SocialAuthClient } from './services/social.ts';

/**
 * 외부 연동 지점. SMS·119·배달대행사는 콘솔 구현이고, 실제 사업자가 정해지면 같은 인터페이스로 교체한다.
 * 라이더 앱 푸시만 실제로 보낸다(Expo 푸시 서비스) — 앱이 꺼져 있을 때 사고 확인을 띄우는 유일한 길이라서.
 */

export interface SmsSender {
  send(to: string, body: string): Promise<void>;
}

/** 119 문자 신고 (설계문서 4.3 4단계). 상담원 판단으로만 호출된다. */
export interface EmergencyReporter {
  report(text: string): Promise<void>;
}

/** 배달대행사: 사고 확정 시 진행 중 주문 보류 + 대체배차 요청 */
export interface DispatchGateway {
  requestReassignment(order: { id: string; storeName: string; destination: string }, riderId: string): Promise<void>;
}

/** Expo 푸시 메시지 (https://docs.expo.dev/push-notifications/sending-notifications/) */
export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId: string;
  categoryId?: string;
  ttl?: number;
  interruptionLevel?: 'time-sensitive';
};
export type PushTicket = { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } };

export interface PushSender {
  /** 메시지 순서대로 티켓을 돌려준다. 100개 이하로 나눠 부른다. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
}

export type Providers = { sms: SmsSender; emergency: EmergencyReporter; dispatch: DispatchGateway; push: PushSender; social: SocialAuthClient };

export function expoPush(accessToken?: string): PushSender {
  return {
    async send(messages) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(messages),
        signal: externalTimeout(),
      });
      if (!res.ok) throw new Error(`Expo 푸시 ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return ((await res.json()) as { data: PushTicket[] }).data;
    },
  };
}

export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void };

export const consoleLogger: Logger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN ${msg}`),
  error: (msg, err) => console.error(`[${new Date().toISOString()}] ERROR ${msg}`, err ?? ''),
};

export function consoleProviders(log: Logger, push?: PushSender): Providers {
  return {
    social: httpSocialAuth,
    push: push ?? {
      async send(messages) {
        for (const m of messages) log.info(`[푸시 → ${m.to}] ${m.title} — ${m.body}`);
        return messages.map((_, i) => ({ status: 'ok', id: `console-${i}` }));
      },
    },
    sms: {
      async send(to, body) {
        log.info(`[SMS → ${to}] ${body}`);
      },
    },
    emergency: {
      async report(text) {
        log.info(`[119 문자신고]\n${text}`);
      },
    },
    dispatch: {
      async requestReassignment(order, riderId) {
        log.info(`[배달대행사] 주문 ${order.id} (${order.storeName} → ${order.destination}) 보류, 대체배차 요청 — rider ${riderId}`);
      },
    },
  };
}
