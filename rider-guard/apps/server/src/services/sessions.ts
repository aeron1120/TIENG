import type { LocationPoint, SessionDto } from '@rider-guard/contract';

import type { AppContext, LocationRow, SessionRow } from '../context.ts';
import { ApiError, iso, newId, seoulDayStart } from '../lib.ts';

/** 휴대폰 시계가 조금 빨라도 받아 주는 여유 */
const CLOCK_SKEW_MS = 60_000;

export function activeSession(ctx: AppContext, riderId: string): SessionRow | undefined {
  return ctx.db.get<SessionRow>('SELECT * FROM sessions WHERE riderId = :riderId AND endedAt IS NULL', { riderId });
}

export function requireActiveSession(ctx: AppContext, riderId: string): SessionRow {
  const session = activeSession(ctx, riderId);
  if (!session) throw new ApiError(409, 'no_active_session', '운행 중이 아니에요. 운행을 시작하면 사고 감지와 위치 공유가 켜져요.');
  return session;
}

/** 운행 시작. 이미 운행 중이면 그 세션을 그대로 돌려준다. */
export function startSession(ctx: AppContext, riderId: string): SessionRow {
  const existing = activeSession(ctx, riderId);
  if (existing) return existing;
  const now = ctx.clock.now();
  const session: SessionRow = {
    id: newId('ses'),
    riderId,
    startedAt: now,
    endedAt: null,
    endReason: null,
    expiresAt: now + ctx.config.sessionMaxHours * 3_600_000,
  };
  ctx.db.run(
    'INSERT INTO sessions (id, riderId, startedAt, endedAt, endReason, expiresAt) VALUES (:id, :riderId, :startedAt, :endedAt, :endReason, :expiresAt)',
    session,
  );
  return session;
}

/** 운행 종료. 종료와 함께 실시간 공유도 꺼진다 — 공유 권한은 세션 존재 여부로 판단하기 때문. */
export function endSession(ctx: AppContext, riderId: string): SessionRow {
  const session = requireActiveSession(ctx, riderId);
  const endedAt = ctx.clock.now();
  ctx.db.run("UPDATE sessions SET endedAt = :endedAt, endReason = 'rider' WHERE id = :id", { endedAt, id: session.id });
  return { ...session, endedAt, endReason: 'rider' };
}

/** 종료를 잊은 세션을 만료 시각 기준으로 닫는다 (4.1.1). */
export function expireSessions(ctx: AppContext): number {
  return ctx.db.run("UPDATE sessions SET endedAt = expiresAt, endReason = 'auto_expired' WHERE endedAt IS NULL AND expiresAt <= :now", {
    now: ctx.clock.now(),
  });
}

export function todayDriveSeconds(ctx: AppContext, riderId: string): number {
  const now = ctx.clock.now();
  const dayStart = seoulDayStart(now);
  const rows = ctx.db.all<Pick<SessionRow, 'startedAt' | 'endedAt'>>(
    'SELECT startedAt, endedAt FROM sessions WHERE riderId = :riderId AND (endedAt IS NULL OR endedAt > :dayStart)',
    { riderId, dayStart },
  );
  const ms = rows.reduce((sum, s) => sum + Math.max(0, Math.min(s.endedAt ?? now, now) - Math.max(s.startedAt, dayStart)), 0);
  return Math.floor(ms / 1000);
}

/**
 * 위치 일괄 업로드. 세션 기간 밖에서 기록된 점은 버린다 —
 * 운행 중이 아닐 때는 아무것도 수집하지 않는다는 약속을 서버에서도 강제한다 (2.1, 9.4).
 * 이미 끝난 세션이라도 그 기간에 기록된 점이면 받는다 (통신 음영 후 일괄 전송, 4.1.4).
 */
export function addLocations(ctx: AppContext, riderId: string, sessionId: string, points: LocationPoint[]) {
  const session = ctx.db.get<SessionRow>('SELECT * FROM sessions WHERE id = :id AND riderId = :riderId', { id: sessionId, riderId });
  if (!session) throw new ApiError(404, 'not_found', '운행 기록을 찾을 수 없어요.');

  const from = session.startedAt;
  const to = (session.endedAt ?? ctx.clock.now()) + CLOCK_SKEW_MS;
  let accepted = 0;
  ctx.db.tx(() => {
    for (const p of points) {
      const recordedAt = Date.parse(p.recordedAt);
      if (!(recordedAt >= from && recordedAt <= to)) continue;
      ctx.db.run(
        `INSERT INTO locations (riderId, sessionId, recordedAt, lat, lng, accuracy, speed, heading)
         VALUES (:riderId, :sessionId, :recordedAt, :lat, :lng, :accuracy, :speed, :heading)`,
        { riderId, sessionId, recordedAt, lat: p.lat, lng: p.lng, accuracy: p.accuracy, speed: p.speed, heading: p.heading },
      );
      accepted++;
    }
  });
  return { accepted, rejected: points.length - accepted };
}

export function latestLocation(ctx: AppContext, riderId: string, sinceMs: number): LocationRow | undefined {
  return ctx.db.get<LocationRow>(
    'SELECT * FROM locations WHERE riderId = :riderId AND recordedAt >= :sinceMs ORDER BY recordedAt DESC LIMIT 1',
    { riderId, sinceMs },
  );
}

export function toSessionDto(s: SessionRow): SessionDto {
  return { id: s.id, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt), endReason: s.endReason, expiresAt: iso(s.expiresAt) };
}
