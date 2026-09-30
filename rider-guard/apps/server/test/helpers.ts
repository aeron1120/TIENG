import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { Db } from '../src/db.ts';
import type { Providers, PushMessage, PushTicket } from '../src/providers.ts';
import type { SocialProfile } from '../src/services/auth.ts';
import { processDue, processHousekeeping } from '../src/services/scheduler.ts';
import { SocialAuthError } from '../src/services/social.ts';

export type Sent = { to: string; body: string };

/** 메모리 DB + 손으로 돌리는 시계 + 보낸 문자를 모으는 가짜 SMS */
export async function setup(env: Record<string, string> = {}) {
  let now = Date.parse('2026-09-24T12:40:00Z'); // 21:40 KST
  const sms: Sent[] = [];
  const reports: string[] = [];
  const reassigned: string[] = [];
  const pushes: PushMessage[] = [];
  /** 가짜 SNS: 제공자가 code 로 돌려줄 프로필. 없는 code 는 교환 실패. */
  const socialProfiles = new Map<string, SocialProfile>();
  const socialCalls: { provider: string; code: string; redirectUri: string; clientSecret: string; verifier?: string | null; nonce?: string | null }[] = [];
  /** 가짜 카카오 연결 끊기: 부른 회원번호를 모은다. fails 면 실패, hangs 면 영영 응답하지 않는다. */
  const unlinked: { subject: string; adminKey: string }[] = [];
  const unlink = { fails: false, hangs: false };
  /** 토큰별 응답을 바꿔 끼울 수 있게 */
  let pushTicket = (_m: PushMessage): PushTicket => ({ status: 'ok', id: `t${pushes.length}` });
  const providers: Providers = {
    sms: { send: async (to, body) => void sms.push({ to, body }) },
    emergency: { report: async (text) => void reports.push(text) },
    dispatch: { requestReassignment: async (order) => void reassigned.push(order.id) },
    push: { send: async (messages) => messages.map((m) => (pushes.push(m), pushTicket(m))) },
    social: {
      authorizeUrl: (provider, creds, redirectUri, state) =>
        `https://${provider}.example/authorize?${new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, state })}`,
      fetchProfile: async (provider, creds, input) => {
        socialCalls.push({ provider, code: input.code, redirectUri: input.redirectUri, clientSecret: creds.clientSecret, ...(provider === 'google' ? { verifier: input.verifier, nonce: input.nonce } : {}) });
        const profile = socialProfiles.get(input.code);
        if (!profile || profile.provider !== provider) throw new SocialAuthError('invalid_grant');
        return profile;
      },
      unlinkKakao: async (subject, adminKey) => {
        if (unlink.hangs) await new Promise(() => {});
        if (unlink.fails) throw new SocialAuthError('카카오 서버 오류');
        unlinked.push({ subject, adminKey });
      },
    },
  };
  const silent = { info() {}, warn() {}, error() {} };
  const ctx: AppContext = {
    db: await Db.open(':memory:'),
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

  /** 시계를 앞으로 돌리고 스케줄러(사고 대응 + 정리 작업)를 한 번 돌린다. */
  async function advance(seconds: number) {
    now += seconds * 1000;
    await processDue(ctx);
    await processHousekeeping(ctx);
  }

  /** 이메일로 가입하고 가입 정보(이름·휴대폰·필수 동의)까지 마친 라이더의 토큰 */
  async function login(phone = '010-1234-5678') {
    const email = `${phone.replace(/\D/g, '')}@rider.test`;
    const signup = await call<{ token: string }>('POST', '/auth/signup', { body: { email, password: 'password123' } });
    const token = signup.status === 201 ? signup.json.token : (await call<{ token: string }>('POST', '/auth/login', { body: { email, password: 'password123' } })).json.token;
    await call('POST', '/me/onboarding', {
      token,
      body: { name: '테스트 라이더', phone, consents: { locationSensor: true, shareOnIncident: true, insuranceRecords: false } },
    });
    return token;
  }

  /** 운영 모니터 API (읽기 전용) */
  const ops = (method: string, path: string, body?: unknown) =>
    call(method, `/ops/api${path}`, { body, headers: { authorization: `Bearer ${ctx.config.opsToken}` } });

  const setPushTicket = (fn: (m: PushMessage) => PushTicket) => {
    pushTicket = fn;
  };
  return { ctx, call, advance, login, ops, sms, reports, reassigned, pushes, setPushTicket, socialProfiles, socialCalls, unlinked, unlink, now: () => now };
}
