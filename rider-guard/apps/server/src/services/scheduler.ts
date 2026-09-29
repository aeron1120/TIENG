import type { AppContext, ContactRow, IncidentRow, NotificationRow, OrderRow } from '../context.ts';
import { escalate } from './incidents.ts';
import { deliverPushes } from './push.ts';
import { expireSessions } from './sessions.ts';
import { CONFIRMED_STATUSES, createShareLink } from './sharing.ts';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
/** 위치정보 이용·제공 사실 확인자료 보존 기간. 위치정보법 제16조는 6개월 이상 — 가장 긴 6개월(184일)을 채우고 지운다. */
export const LOCATION_ACCESS_RETENTION_MS = 184 * DAY_MS;
/** 카카오 연결 끊기 재시도 한도. 1분·2분·4분… 최대 하루 간격이라 20번이면 약 2주. */
const UNLINK_MAX_ATTEMPTS = 20;

/**
 * 시간이 흘러야 일어나는 일을 처리한다. 라이더 앱이 꺼져 있어도(= 의식을 잃었어도) 에스컬레이션이 진행돼야 하므로
 * 서버가 주기적으로 돈다. 모든 대상은 DB 상태에서 다시 계산하므로 재시작해도 이어서 처리된다.
 */
export async function processDue(ctx: AppContext) {
  const now = ctx.clock.now();

  // 2단계 진입: 취소 카운트다운 만료 → 무응답 에스컬레이션
  const expired = await ctx.db.all<IncidentRow>("SELECT * FROM incidents WHERE status = 'countdown' AND deadlineAt <= :now", { now });
  for (const incident of expired) {
    if (await escalate(ctx, incident, 'no_response')) ctx.log.info(`사고 ${incident.id}: ${incident.countdownSeconds}초 무응답 → 에스컬레이션`);
  }

  // 라이더 푸시 — 문자보다 먼저. 라이더가 스스로 취소할 기회가 가장 싸다.
  await deliverPushes(ctx);

  // 배달대행사 대체배차 요청 (outbox)
  const orders = await ctx.db.all<OrderRow>("SELECT * FROM orders WHERE status = 'held' AND reassignRequestedAt IS NULL");
  for (const order of orders) {
    if (!(await ctx.db.run('UPDATE orders SET reassignRequestedAt = :now WHERE id = :id AND reassignRequestedAt IS NULL', { id: order.id, now }))) continue;
    try {
      await ctx.providers.dispatch.requestReassignment(order, order.riderId);
    } catch (error) {
      ctx.log.error(`주문 ${order.id} 대체배차 요청 실패 — 다음 주기에 다시 시도`, error);
      await ctx.db.run('UPDATE orders SET reassignRequestedAt = NULL WHERE id = :id', { id: order.id });
    }
  }

  // 문자 발송
  const due = await ctx.db.all<NotificationRow>("SELECT * FROM notifications WHERE status = 'pending' AND dueAt <= :now ORDER BY dueAt LIMIT 50", {
    now,
  });
  for (const notification of due) await deliver(ctx, notification);

  await expireSessions(ctx);
}

/**
 * 급하지 않은 정리 작업. 사고 대응 루프(processDue)와 따로 돈다 — 외부 API(카카오)가 느려도 에스컬레이션·문자·푸시가 밀리지 않게.
 */
export async function processHousekeeping(ctx: AppContext) {
  const now = ctx.clock.now();
  // 끝난 SNS 로그인 시도와 쓰지 않은 1회용 코드 정리
  await ctx.db.run('DELETE FROM oauthStates WHERE expiresAt < :now', { now });
  await ctx.db.run('DELETE FROM loginCodes WHERE expiresAt < :now', { now });
  // 보존 기간이 지난 위치 이용·제공 기록 파기 (탈퇴 회원 것도 이때 지워진다 — 개인정보보호법 제21조)
  await ctx.db.run('DELETE FROM locationAccessLogs WHERE at < :cutoff', { cutoff: now - LOCATION_ACCESS_RETENTION_MS });

  await unlinkDeletedKakaoAccounts(ctx, now);
}

/** 탈퇴한 회원의 카카오 연결 끊기. Admin 키가 없으면 쌓아 두었다가 키를 넣으면 보낸다. */
async function unlinkDeletedKakaoAccounts(ctx: AppContext, now: number) {
  const adminKey = ctx.config.kakaoAdminKey;
  if (!adminKey) return;
  const due = await ctx.db.all<{ id: number; subject: string; attempts: number; dueAt: number }>(
    "SELECT id, subject, attempts, dueAt FROM socialUnlinks WHERE provider = 'kakao' AND dueAt <= :now ORDER BY dueAt LIMIT 20",
    { now },
  );
  for (const row of due) {
    // 그사이 같은 카카오 계정으로 다시 가입했으면 끊지 않는다 (가입할 때도 지우지만 한 번 더)
    if (await ctx.db.get("SELECT 1 FROM riderIdentities WHERE provider = 'kakao' AND subject = :subject", { subject: row.subject })) {
      await ctx.db.run('DELETE FROM socialUnlinks WHERE id = :id', { id: row.id });
      continue;
    }
    const attempts = row.attempts + 1;
    // 선점: 다음 시도 시각을 먼저 밀어 둔다 — 같은 행을 두 번 보내지 않게, 서버가 도중에 꺼져도 나중에 다시 가게
    const retryAt = now + Math.min(2 ** (attempts - 1) * 60_000, DAY_MS);
    const claimed = await ctx.db.run('UPDATE socialUnlinks SET attempts = :attempts, dueAt = :retryAt WHERE id = :id AND dueAt = :dueAt', {
      id: row.id,
      attempts,
      retryAt,
      dueAt: row.dueAt,
    });
    if (!claimed) continue;
    try {
      await ctx.providers.social.unlinkKakao(row.subject, adminKey);
      await ctx.db.run('DELETE FROM socialUnlinks WHERE id = :id', { id: row.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempts >= UNLINK_MAX_ATTEMPTS) {
        // 회원번호는 수동으로 끊을 수 있게 로그에만 남기고 행은 지운다 (탈퇴 회원 정보를 붙들고 있지 않게)
        ctx.log.error(`카카오 연결 끊기 포기 — 회원번호 ${row.subject}, ${attempts}회: ${message}`);
        await ctx.db.run('DELETE FROM socialUnlinks WHERE id = :id', { id: row.id });
      } else {
        ctx.log.warn(`카카오 연결 끊기 실패 (${attempts}회) — 다시 시도: ${message}`);
        await ctx.db.run('UPDATE socialUnlinks SET error = :error WHERE id = :id', { id: row.id, error: message.slice(0, 500) });
      }
    }
  }
}

async function deliver(ctx: AppContext, n: NotificationRow) {
  // 선점: 같은 알림을 두 번 보내지 않도록 pending → sending 을 조건부로 바꾼 쪽만 보낸다.
  if (!(await ctx.db.run("UPDATE notifications SET status = 'sending', attempts = attempts + 1 WHERE id = :id AND status = 'pending'", { id: n.id }))) return;

  const incident = (await ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = :id', { id: n.incidentId }))!;
  const contact = n.contactId ? await ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE id = :id', { id: n.contactId }) : undefined;
  const stale = n.purpose === 'contact_alert' && (!contact || !(CONFIRMED_STATUSES as readonly string[]).includes(incident.status));
  if (stale) {
    await ctx.db.run("UPDATE notifications SET status = 'cancelled' WHERE id = :id", { id: n.id });
    return;
  }

  // 링크는 보낼 때 만든다. 토큰 원문은 문자에만 실리고 DB 에는 해시만 남는다.
  const body = n.body.includes('{link}') ? n.body.replace('{link}', (await createShareLink(ctx, { riderId: incident.riderId, contactId: contact!.id, incidentId: incident.id })).url) : n.body;
  try {
    await ctx.providers.sms.send(n.recipient, body);
    const sentAt = ctx.clock.now();
    await ctx.db.tx(async () => {
      await ctx.db.run("UPDATE notifications SET status = 'sent', sentAt = :sentAt, error = NULL WHERE id = :id", { id: n.id, sentAt });
      if (n.purpose === 'contact_alert' && contact) {
        await ctx.db.run('INSERT INTO incidentEvents (incidentId, type, at, dataJson) VALUES (:incidentId, :type, :at, :dataJson)', {
          incidentId: incident.id,
          type: 'contact_notified',
          at: sentAt,
          dataJson: JSON.stringify({ contactId: contact.id, priority: contact.priority, name: contact.name }),
        });
      }
    });
  } catch (error) {
    const attempts = n.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempts < MAX_ATTEMPTS) {
      ctx.log.warn(`문자 발송 실패 (${attempts}/${MAX_ATTEMPTS}) → ${n.recipient}: ${message}`);
      await ctx.db.run("UPDATE notifications SET status = 'pending', dueAt = :dueAt, error = :message WHERE id = :id", {
        id: n.id,
        dueAt: ctx.clock.now() + RETRY_BASE_MS * attempts,
        message,
      });
    } else {
      ctx.log.error(`문자 발송 최종 실패 → ${n.recipient}`, error);
      await ctx.db.tx(async () => {
        await ctx.db.run("UPDATE notifications SET status = 'failed', error = :message WHERE id = :id", { id: n.id, message });
        await ctx.db.run('INSERT INTO incidentEvents (incidentId, type, at, dataJson) VALUES (:incidentId, :type, :at, :dataJson)', {
          incidentId: incident.id,
          type: 'contact_notify_failed',
          at: ctx.clock.now(),
          dataJson: JSON.stringify({ contactId: n.contactId, priority: contact?.priority ?? null, error: message }),
        });
      });
    }
  }
}

/** 발송 도중 서버가 꺼졌던 알림을 되살린다. 한 번 더 갈 수는 있어도 빠뜨리지는 않는 쪽을 택한다. */
export async function recoverOutbox(ctx: AppContext) {
  await ctx.db.run("UPDATE notifications SET status = 'pending' WHERE status = 'sending'");
  await ctx.db.run("UPDATE pushes SET status = 'pending' WHERE status = 'sending'");
}

/** 한 주기가 끝나기 전에는 다음 주기를 건너뛰는 반복. 오류는 여기서 전부 잡는다 — 한 번 실패해도 다음 주기는 돈다. */
function loop(ctx: AppContext, name: string, fn: (ctx: AppContext) => Promise<void>, intervalMs: number) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn(ctx);
    } catch (error) {
      ctx.log.error(`${name} 오류`, error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}

export function startScheduler(ctx: AppContext, intervalMs = 1000): () => void {
  const stops = [loop(ctx, '스케줄러', processDue, intervalMs), loop(ctx, '정리 작업', processHousekeeping, 30 * intervalMs)];
  return () => stops.forEach((stop) => stop());
}
