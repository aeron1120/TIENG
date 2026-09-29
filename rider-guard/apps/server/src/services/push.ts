import type { PushData } from '@rider-guard/contract';

import type { AppContext, IncidentRow } from '../context.ts';
import { newId } from '../lib.ts';
import type { PushMessage } from '../providers.ts';

/**
 * 라이더 휴대폰 푸시. 앱이 꺼져 있거나 백그라운드여도 사고 확인을 띄우는 경로다 (설계문서 4.3 1단계).
 *   incident_detected  사고 감지 직후 — "괜찮으신가요?" + 괜찮아요/도움이 필요해요 버튼 (잠금화면에서 바로 응답)
 *   escalated          무응답으로 비상연락이 시작됨 — 라이더가 나중에 폰을 봤을 때 무슨 일이 있었는지 알게
 */
export type PushKind = 'incident_detected' | 'escalated';

const MAX_ATTEMPTS = 3;
/** 사고 알림은 늦으면 의미가 없어 문자보다 짧게 다시 시도한다. */
const RETRY_MS = 5_000;
export const PUSH_CHANNEL = 'incident';
export const PUSH_CATEGORY = 'incident';

type PushRow = { id: string; riderId: string; incidentId: string; kind: PushKind; attempts: number };

/** 사고 트랜잭션 안에서 부른다 — 사고가 되돌려지면 푸시도 같이 사라진다. */
export async function enqueuePush(ctx: AppContext, incident: Pick<IncidentRow, 'id' | 'riderId'>, kind: PushKind) {
  await ctx.db.run(
    `INSERT INTO pushes (id, riderId, incidentId, kind, dueAt, status, attempts) VALUES (:id, :riderId, :incidentId, :kind, :dueAt, 'pending', 0)`,
    { id: newId('psh'), riderId: incident.riderId, incidentId: incident.id, kind, dueAt: ctx.clock.now() },
  );
}

export async function savePushToken(ctx: AppContext, riderId: string, token: string, platform: 'ios' | 'android') {
  await ctx.db.run(
    `INSERT INTO pushTokens (token, riderId, platform, updatedAt) VALUES (:token, :riderId, :platform, :now)
     ON CONFLICT (token) DO UPDATE SET riderId = excluded.riderId, platform = excluded.platform, updatedAt = excluded.updatedAt`,
    { token, riderId, platform, now: ctx.clock.now() },
  );
}

export async function removePushToken(ctx: AppContext, riderId: string, token: string) {
  await ctx.db.run('DELETE FROM pushTokens WHERE token = :token AND riderId = :riderId', { token, riderId });
}

function message(kind: PushKind, incident: IncidentRow, to: string): PushMessage {
  const data: PushData = { type: kind === 'incident_detected' ? 'incident' : 'status', incidentId: incident.id };
  const common = { to, data, sound: 'default', priority: 'high', channelId: PUSH_CHANNEL, categoryId: PUSH_CATEGORY, interruptionLevel: 'time-sensitive' } as const;
  return kind === 'incident_detected'
    ? {
        ...common,
        title: incident.kind === 'fall' ? '넘어짐이 감지됐어요' : '강한 충격이 감지됐어요',
        body: `괜찮으신가요? ${incident.countdownSeconds}초 안에 응답이 없으면 비상연락처와 119에 알려요.`,
        ttl: 600,
      }
    : { ...common, title: '비상연락을 시작했어요', body: '응답이 없어 비상연락처와 119에 위치를 알렸어요. 괜찮으면 알려 주세요.', ttl: 3600 };
}

/** 스케줄러가 부른다. */
export async function deliverPushes(ctx: AppContext) {
  const due = await ctx.db.all<PushRow>("SELECT * FROM pushes WHERE status = 'pending' AND dueAt <= :now ORDER BY dueAt LIMIT 20", { now: ctx.clock.now() });
  for (const p of due) {
    if (!(await ctx.db.run("UPDATE pushes SET status = 'sending', attempts = attempts + 1 WHERE id = :id AND status = 'pending'", { id: p.id }))) continue;
    const finish = (status: string, error: string | null = null) =>
      ctx.db.run('UPDATE pushes SET status = :status, error = :error, sentAt = :now WHERE id = :id', { id: p.id, status, error, now: ctx.clock.now() });

    const incident = (await ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = :id', { id: p.incidentId }))!;
    // 카운트다운이 끝났으면 "괜찮으신가요?" 를 뒤늦게 띄우지 않는다 — 이미 응답했거나,
    // 무응답 에스컬레이션이면 escalated 푸시가 대신 간다.
    if (p.kind === 'incident_detected' && incident.status !== 'countdown') {
      await finish('skipped');
      continue;
    }
    const tokens = (await ctx.db.all<{ token: string }>('SELECT token FROM pushTokens WHERE riderId = :riderId', { riderId: p.riderId })).map((t) => t.token);
    if (!tokens.length) {
      await finish('no_token');
      continue;
    }

    try {
      const tickets = await ctx.providers.push.send(tokens.map((t) => message(p.kind, incident, t)));
      let delivered = 0;
      const errors: string[] = [];
      for (const [i, ticket] of tickets.entries()) {
        if (ticket.status === 'ok') {
          delivered++;
          continue;
        }
        errors.push(ticket.details?.error ?? ticket.message);
        // 앱을 지웠거나 토큰이 바뀐 기기. 계속 보내면 Expo 가 막는다.
        if (ticket.details?.error === 'DeviceNotRegistered') await ctx.db.run('DELETE FROM pushTokens WHERE token = :token', { token: tokens[i]! });
      }
      await finish(delivered ? 'sent' : 'failed', errors.join(',') || null);
      if (delivered) {
        await ctx.db.run('INSERT INTO incidentEvents (incidentId, type, at, dataJson) VALUES (:incidentId, :type, :at, :dataJson)', {
          incidentId: incident.id,
          type: 'rider_notified',
          at: ctx.clock.now(),
          dataJson: JSON.stringify({ kind: p.kind, devices: delivered }),
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (p.attempts + 1 < MAX_ATTEMPTS) {
        ctx.log.warn(`푸시 실패 (${p.attempts + 1}/${MAX_ATTEMPTS}): ${msg}`);
        await ctx.db.run("UPDATE pushes SET status = 'pending', dueAt = :dueAt, error = :msg WHERE id = :id", {
          id: p.id,
          dueAt: ctx.clock.now() + RETRY_MS * (p.attempts + 1),
          msg,
        });
      } else {
        ctx.log.error('푸시 최종 실패', error);
        await finish('failed', msg);
      }
    }
  }
}
