import type { Consents, OtpResponse } from '@rider-guard/contract';

import type { AppContext, RiderRow } from '../context.ts';
import { ApiError, newId, newToken, safeEqual, sha256, sixDigits } from '../lib.ts';
import { REQUIRED_CONSENTS, setConsents } from './riders.ts';

const MAX_OTP_ATTEMPTS = 5;
const TOKEN_TTL_MS = 30 * 24 * 3_600_000;

type OtpRow = { phone: string; codeHash: string; expiresAt: number; attempts: number; sentAt: number };

export async function requestOtp(ctx: AppContext, phone: string): Promise<OtpResponse> {
  const now = ctx.clock.now();
  const current = ctx.db.get<OtpRow>('SELECT * FROM otpCodes WHERE phone = :phone', { phone });
  const wait = current ? Math.ceil((current.sentAt + ctx.config.otpResendSeconds * 1000 - now) / 1000) : 0;
  if (wait > 0) throw new ApiError(429, 'otp_too_soon', `${wait}초 뒤에 다시 받을 수 있어요.`);

  const code = sixDigits();
  ctx.db.run(
    `INSERT INTO otpCodes (phone, codeHash, expiresAt, attempts, sentAt) VALUES (:phone, :codeHash, :expiresAt, 0, :now)
     ON CONFLICT (phone) DO UPDATE SET codeHash = excluded.codeHash, expiresAt = excluded.expiresAt, attempts = 0, sentAt = excluded.sentAt`,
    { phone, codeHash: sha256(`${phone}:${code}`), expiresAt: now + ctx.config.otpTtlSeconds * 1000, now },
  );
  await ctx.providers.sms.send(phone, `[Rider Guard] 인증번호 ${code} (${Math.round(ctx.config.otpTtlSeconds / 60)}분 안에 입력)`);
  return {
    expiresInSeconds: ctx.config.otpTtlSeconds,
    resendAfterSeconds: ctx.config.otpResendSeconds,
    ...(ctx.config.env === 'production' ? {} : { devCode: code }),
  };
}

/** 인증번호가 맞으면 라이더를 만들거나 찾고, 필수 동의를 기록한 뒤 토큰을 발급한다. */
export function verifyOtp(ctx: AppContext, phone: string, code: string, consents: Partial<Consents>): { token: string; rider: RiderRow; isNew: boolean } {
  const missing = REQUIRED_CONSENTS.filter((k) => !consents[k]);
  if (missing.length) throw new ApiError(400, 'consent_required', '필수 동의 항목에 모두 동의해야 시작할 수 있어요.');

  const now = ctx.clock.now();
  const otp = ctx.db.get<OtpRow>('SELECT * FROM otpCodes WHERE phone = :phone', { phone });
  if (!otp || otp.expiresAt <= now) throw new ApiError(400, 'otp_expired', '인증번호가 만료됐어요. 다시 받아 주세요.');
  if (otp.attempts >= MAX_OTP_ATTEMPTS) throw new ApiError(429, 'otp_locked', '인증번호를 여러 번 틀렸어요. 다시 받아 주세요.');
  if (!safeEqual(otp.codeHash, sha256(`${phone}:${code}`))) {
    // 트랜잭션 밖에서 올려야 오류와 함께 되돌려지지 않는다.
    ctx.db.run('UPDATE otpCodes SET attempts = attempts + 1 WHERE phone = :phone', { phone });
    throw new ApiError(400, 'otp_mismatch', '인증번호가 맞지 않아요.');
  }

  return ctx.db.tx(() => {
    // 같은 코드로 동시에 두 번 로그인하지 못하게 소비를 선점한다.
    if (!ctx.db.run('DELETE FROM otpCodes WHERE phone = :phone AND codeHash = :codeHash', { phone, codeHash: otp.codeHash })) {
      throw new ApiError(400, 'otp_expired', '인증번호가 만료됐어요. 다시 받아 주세요.');
    }

    let rider = ctx.db.get<RiderRow>('SELECT * FROM riders WHERE phone = :phone', { phone });
    const isNew = !rider;
    if (!rider) {
      rider = { id: newId('rdr'), phone, name: null, vehicleJson: null, medicalJson: null, createdAt: now };
      ctx.db.run(
        'INSERT INTO riders (id, phone, name, vehicleJson, medicalJson, createdAt) VALUES (:id, :phone, :name, :vehicleJson, :medicalJson, :createdAt)',
        rider,
      );
    }
    setConsents(ctx, rider.id, consents);

    const token = newToken();
    ctx.db.run('INSERT INTO authTokens (tokenHash, riderId, createdAt, expiresAt) VALUES (:tokenHash, :riderId, :now, :expiresAt)', {
      tokenHash: sha256(token),
      riderId: rider.id,
      now,
      expiresAt: now + TOKEN_TTL_MS,
    });
    return { token, rider, isNew };
  });
}

export function riderIdForToken(ctx: AppContext, token: string): string | null {
  const row = ctx.db.get<{ riderId: string }>('SELECT riderId FROM authTokens WHERE tokenHash = :tokenHash AND expiresAt > :now', {
    tokenHash: sha256(token),
    now: ctx.clock.now(),
  });
  return row?.riderId ?? null;
}

export function revokeToken(ctx: AppContext, token: string) {
  ctx.db.run('DELETE FROM authTokens WHERE tokenHash = :tokenHash', { tokenHash: sha256(token) });
}
