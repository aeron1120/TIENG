import type { AppContext, RiderRow } from '../context.ts';
import { ApiError, newId, newToken, sha256 } from '../lib.ts';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.ts';

const TOKEN_TTL_MS = 30 * 24 * 3_600_000;
/** 비밀번호를 연달아 틀리면 잠시 막는다 — 대입 공격 */
const MAX_LOGIN_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

async function insertRider(ctx: AppContext, fields: Partial<RiderRow>): Promise<RiderRow> {
  const rider: RiderRow = {
    id: newId('rdr'),
    email: null,
    passwordHash: null,
    loginFailures: 0,
    lockedUntil: null,
    name: null,
    phone: null,
    onboardedAt: null,
    vehicleJson: null,
    medicalJson: null,
    createdAt: ctx.clock.now(),
    ...fields,
  };
  await ctx.db.run(
    `INSERT INTO riders (id, email, passwordHash, loginFailures, lockedUntil, name, phone, onboardedAt, vehicleJson, medicalJson, createdAt)
     VALUES (:id, :email, :passwordHash, :loginFailures, :lockedUntil, :name, :phone, :onboardedAt, :vehicleJson, :medicalJson, :createdAt)`,
    rider,
  );
  return rider;
}

/** 로그인 토큰 발급. DB 에는 해시만 남는다. */
export async function issueToken(ctx: AppContext, riderId: string): Promise<string> {
  const token = newToken();
  const now = ctx.clock.now();
  await ctx.db.run('INSERT INTO authTokens (tokenHash, riderId, createdAt, expiresAt) VALUES (:tokenHash, :riderId, :now, :expiresAt)', {
    tokenHash: sha256(token),
    riderId,
    now,
    expiresAt: now + TOKEN_TTL_MS,
  });
  return token;
}

// ── 이메일 + 비밀번호 ──────────────────────────────────────────

export async function signupWithEmail(ctx: AppContext, rawEmail: string, password: string): Promise<{ rider: RiderRow; token: string }> {
  const email = normalizeEmail(rawEmail);
  // 해시는 트랜잭션 밖에서 — 수십 ms 걸리는 동안 다른 요청을 막지 않게
  const passwordHash = await hashPassword(password);
  return ctx.db.tx(async () => {
    if (await ctx.db.get('SELECT 1 FROM riders WHERE email = :email', { email })) {
      throw new ApiError(409, 'email_taken', '이미 가입된 이메일이에요. 로그인해 주세요.');
    }
    const rider = await insertRider(ctx, { email, passwordHash });
    return { rider, token: await issueToken(ctx, rider.id) };
  });
}

/**
 * 가입하지 않은 이메일과 비밀번호가 틀린 경우를 같은 문장·같은 시간으로 답한다 — 가입 여부를 알아내지 못하게.
 * 5번 틀리면 15분 잠근다. 잠금은 맞는 비밀번호로도 풀리지 않는다.
 */
export async function loginWithEmail(ctx: AppContext, rawEmail: string, password: string): Promise<{ rider: RiderRow; token: string }> {
  const email = normalizeEmail(rawEmail);
  const rider = await ctx.db.get<RiderRow>('SELECT * FROM riders WHERE email = :email', { email });
  const wrong = new ApiError(401, 'invalid_credentials', '이메일 또는 비밀번호가 맞지 않아요.');
  if (!rider?.passwordHash) {
    await burnPasswordCheck(password);
    throw wrong;
  }
  const now = ctx.clock.now();
  const params = { id: rider.id, now, max: MAX_LOGIN_FAILURES };
  // 비밀번호를 확인하기 전에 시도 한 번을 먼저 센다(예약). 확인(scrypt)은 수십 ms 라, 확인 뒤에 세면
  // 동시에 보낸 수백 개가 모두 잠금 검사를 통과한다. 잠금 창 하나에서 확인까지 가는 시도는 최대 5번.
  const reserved = await ctx.db.run(
    `UPDATE riders SET loginFailures = loginFailures + 1, lockedUntil = NULL
     WHERE id = :id AND (lockedUntil IS NULL OR lockedUntil <= :now) AND loginFailures < :max`,
    params,
  );
  if (!reserved) {
    // 센 시도가 한도인데 잠금이 없다 = 확인 중인 요청이 남아 있거나, 확인 도중 끝나지 못했다(크래시·DB 오류).
    // 어느 쪽이든 보통 잠금으로 바꾼다 — 그대로 두면 풀리는 시각이 없어 영영 로그인할 수 없다.
    await ctx.db.run('UPDATE riders SET lockedUntil = :lockUntil, loginFailures = 0 WHERE id = :id AND lockedUntil IS NULL AND loginFailures >= :max', {
      ...params,
      lockUntil: now + LOCK_MS,
    });
    const lock = await ctx.db.get<{ lockedUntil: number | null }>('SELECT lockedUntil FROM riders WHERE id = :id', params);
    const minutes = lock?.lockedUntil && lock.lockedUntil > now ? Math.ceil((lock.lockedUntil - now) / 60_000) : null;
    throw new ApiError(429, 'login_locked', minutes ? `비밀번호를 여러 번 틀려 ${minutes}분 뒤에 다시 시도할 수 있어요.` : '로그인 시도가 너무 많아요. 잠시 뒤에 다시 시도해 주세요.');
  }
  if (!(await verifyPassword(password, rider.passwordHash))) {
    // 이미 센 시도가 한도에 닿았으면 잠근다. 그사이 다른 요청이 잠갔으면 그대로 둔다.
    await ctx.db.run(
      `UPDATE riders SET lockedUntil = :lockUntil, loginFailures = 0
       WHERE id = :id AND loginFailures >= :max AND (lockedUntil IS NULL OR lockedUntil <= :now)`,
      { ...params, lockUntil: now + LOCK_MS },
    );
    throw wrong;
  }
  // 성공하면 센 것을 되돌린다. 단 그사이 다른 요청이 건 잠금은 풀지 않는다.
  await ctx.db.run('UPDATE riders SET loginFailures = 0 WHERE id = :id AND lockedUntil IS NULL', params);
  return { rider, token: await issueToken(ctx, rider.id) };
}

// ── SNS ────────────────────────────────────────────────────────

export type SocialProfile = { provider: 'kakao' | 'naver' | 'google'; subject: string; email: string | null; name: string | null; phone: string | null };

/**
 * SNS 계정으로 라이더를 찾거나 만든다. 제공자의 고유 id(subject)로만 찾는다 —
 * 이메일이 같다고 기존 이메일 계정에 자동으로 붙이지 않는다(제공자가 준 이메일이 검증됐다는 보장이 없다).
 * 새로 만들 때 제공자가 준 이름·휴대폰은 가입 정보 화면의 기본값으로 쓴다.
 */
export async function findOrCreateSocialRider(ctx: AppContext, profile: SocialProfile): Promise<{ rider: RiderRow; isNew: boolean }> {
  return ctx.db.tx(async () => {
    const linked = await ctx.db.get<RiderRow>(
      'SELECT r.* FROM riderIdentities i JOIN riders r ON r.id = i.riderId WHERE i.provider = :provider AND i.subject = :subject',
      { provider: profile.provider, subject: profile.subject },
    );
    if (linked) return { rider: linked, isNew: false };
    const rider = await insertRider(ctx, { name: profile.name, phone: profile.phone });
    await ctx.db.run(
      'INSERT INTO riderIdentities (provider, subject, riderId, email, createdAt) VALUES (:provider, :subject, :riderId, :email, :now)',
      { provider: profile.provider, subject: profile.subject, riderId: rider.id, email: profile.email, now: ctx.clock.now() },
    );
    // 탈퇴했다 다시 가입했다 — 아직 안 보낸 연결 끊기가 새 계정의 연결을 끊지 않게 취소한다
    await ctx.db.run('DELETE FROM socialUnlinks WHERE provider = :provider AND subject = :subject', { provider: profile.provider, subject: profile.subject });
    return { rider, isNew: true };
  });
}

// ── 토큰 ───────────────────────────────────────────────────────

export async function riderIdForToken(ctx: AppContext, token: string): Promise<string | null> {
  const row = await ctx.db.get<{ riderId: string }>('SELECT riderId FROM authTokens WHERE tokenHash = :tokenHash AND expiresAt > :now', {
    tokenHash: sha256(token),
    now: ctx.clock.now(),
  });
  return row?.riderId ?? null;
}

export async function revokeToken(ctx: AppContext, token: string) {
  await ctx.db.run('DELETE FROM authTokens WHERE tokenHash = :tokenHash', { tokenHash: sha256(token) });
}
