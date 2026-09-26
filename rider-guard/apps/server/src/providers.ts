/**
 * 외부 연동 지점. 지금은 전부 콘솔 구현이고, 실제 SMS 사업자·119 문자신고·배달대행사 API 가 정해지면
 * 같은 인터페이스로 교체한다.
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

export type Providers = { sms: SmsSender; emergency: EmergencyReporter; dispatch: DispatchGateway };

export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void };

export const consoleLogger: Logger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN ${msg}`),
  error: (msg, err) => console.error(`[${new Date().toISOString()}] ERROR ${msg}`, err ?? ''),
};

export function consoleProviders(log: Logger): Providers {
  return {
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
