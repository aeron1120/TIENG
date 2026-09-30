import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

// 검증 오류 문구를 앱에 그대로 보여줄 수 있게 한국어로
z.config(z.locales.ko());

// ── 오류 ───────────────────────────────────────────────────────

/** code 는 앱이 분기에 쓰고, message 는 그대로 화면에 보여줄 수 있는 문장이다. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = '대상') => new ApiError(404, 'not_found', `${what}을(를) 찾을 수 없어요.`);

export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', '요청 본문이 올바른 JSON 이 아니에요.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(400, 'invalid_request', `${where}${issue?.message ?? '요청 형식이 올바르지 않아요.'}`);
  }
  return parsed.data;
}

// ── 식별자 · 토큰 ──────────────────────────────────────────────

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const newToken = () => randomBytes(32).toString('base64url');

/** 외부 API(푸시·SNS 제공자) 호출 제한 시간. 없으면 응답 없는 서버를 몇 분씩 기다린다. */
export const externalTimeout = () => AbortSignal.timeout(10_000);
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ── 전화번호 ───────────────────────────────────────────────────

/** 010-1234-5678, +82 10 1234 5678 등을 01012345678 로. 휴대폰 번호가 아니면 null. */
export function normalizeMobile(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('82')) digits = `0${digits.slice(2)}`;
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : null;
}

export const mobileSchema = z.string().transform((value, ctx) => {
  const phone = normalizeMobile(value);
  if (!phone) {
    ctx.addIssue({ code: 'custom', message: '휴대폰 번호 형식이 아니에요.' });
    return z.NEVER;
  }
  return phone;
});

/** 가입 정보를 아직 안 넣은 라이더는 번호가 없다 */
export function formatPhone(phone: string | null): string {
  if (!phone) return '번호 미등록';
  return phone.length === 11 ? `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}` : `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`;
}

export const maskPhone = (phone: string) => formatPhone(phone).replace(/-(\d{3,4})-/, '-****-');

// ── 시간 ───────────────────────────────────────────────────────

export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

export function iso(ms: number): string;
export function iso(ms: number | null | undefined): string | null;
export function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

const KST_OFFSET = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
/** 한국 시간 기준 그날 0시의 epoch ms */
export const seoulDayStart = (ms: number) => Math.floor((ms + KST_OFFSET) / DAY) * DAY - KST_OFFSET;

export function seoulClock(ms: number): string {
  return new Date(ms + KST_OFFSET).toISOString().slice(11, 19);
}

// ── HTML ───────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
