import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { Db } from '../src/db.ts';
import type { Providers } from '../src/providers.ts';
import { processDue } from '../src/services/scheduler.ts';

export type Sent = { to: string; body: string };

/** 메모리 DB + 손으로 돌리는 시계 + 보낸 문자를 모으는 가짜 SMS */
export function setup(env: Record<string, string> = {}) {
  let now = Date.parse('2026-09-24T12:40:00Z'); // 21:40 KST
  const sms: Sent[] = [];
  const reports: string[] = [];
  const reassigned: string[] = [];
  const providers: Providers = {
    sms: { send: async (to, body) => void sms.push({ to, body }) },
    emergency: { report: async (text) => void reports.push(text) },
    dispatch: { requestReassignment: async (order) => void reassigned.push(order.id) },
  };
  const silent = { info() {}, warn() {}, error() {} };
  const ctx: AppContext = {
    db: new Db(':memory:'),
    config: loadConfig({ NODE_ENV: 'test', PUBLIC_BASE_URL: 'https://rg.test', ...env }),
    clock: { now: () => now },
    providers,
    log: silent,
  };
  const app = createApp(ctx);

  async function call<T = any>(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    let json: T = undefined as T;
    try {
      json = JSON.parse(text) as T;
    } catch {
      /* HTML 또는 빈 본문 */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** 시계를 앞으로 돌리고 스케줄러를 한 번 돌린다. */
  async function advance(seconds: number) {
    now += seconds * 1000;
    await processDue(ctx);
  }

  async function login(phone = '010-1234-5678') {
    const otp = await call<{ devCode: string }>('POST', '/auth/otp', { body: { phone } });
    const res = await call<{ token: string }>('POST', '/auth/verify', {
      body: { phone, code: otp.json.devCode, consents: { locationSensor: true, shareOnIncident: true, insuranceRecords: false } },
    });
    return res.json.token;
  }

  const ops = (method: string, path: string, body?: unknown, operator = '김관제') =>
    call(method, `/ops/api${path}`, { body, headers: { authorization: `Bearer ${ctx.config.opsToken}`, 'x-operator': encodeURIComponent(operator) } });

  return { ctx, call, advance, login, ops, sms, reports, reassigned, now: () => now };
}
