import type { AppContext, ContactRow, IncidentRow, NotificationRow, OrderRow } from '../context.ts';
import { escalate } from './incidents.ts';
import { expireSessions } from './sessions.ts';
import { CONFIRMED_STATUSES, createShareLink } from './sharing.ts';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;

/**
 * 시간이 흘러야 일어나는 일을 처리한다. 라이더 앱이 꺼져 있어도(= 의식을 잃었어도) 에스컬레이션이 진행돼야 하므로
 * 서버가 주기적으로 돈다. 모든 대상은 DB 상태에서 다시 계산하므로 재시작해도 이어서 처리된다.
 */
export async function processDue(ctx: AppContext) {
  const now = ctx.clock.now();

  // 2단계 진입: 취소 카운트다운 만료 → 무응답 에스컬레이션
  const expired = ctx.db.all<IncidentRow>("SELECT * FROM incidents WHERE status = 'countdown' AND deadlineAt <= :now", { now });
  for (const incident of expired) {
    if (escalate(ctx, incident, 'no_response')) ctx.log.info(`사고 ${incident.id}: ${incident.countdownSeconds}초 무응답 → 에스컬레이션`);
  }

  // 배달대행사 대체배차 요청 (outbox)
  const orders = ctx.db.all<OrderRow>("SELECT * FROM orders WHERE status = 'held' AND reassignRequestedAt IS NULL");
  for (const order of orders) {
    if (!ctx.db.run('UPDATE orders SET reassignRequestedAt = :now WHERE id = :id AND reassignRequestedAt IS NULL', { id: order.id, now })) continue;
    try {
      await ctx.providers.dispatch.requestReassignment(order, order.riderId);
    } catch (error) {
      ctx.log.error(`주문 ${order.id} 대체배차 요청 실패 — 다음 주기에 다시 시도`, error);
      ctx.db.run('UPDATE orders SET reassignRequestedAt = NULL WHERE id = :id', { id: order.id });
    }
  }

  // 문자 발송
  const due = ctx.db.all<NotificationRow>("SELECT * FROM notifications WHERE status = 'pending' AND dueAt <= :now ORDER BY dueAt LIMIT 50", {
    now,
  });
  for (const notification of due) await deliver(ctx, notification);

  expireSessions(ctx);
  ctx.db.run('DELETE FROM otpCodes WHERE expiresAt < :cutoff', { cutoff: now - 24 * 3_600_000 });
}

async function deliver(ctx: AppContext, n: NotificationRow) {
  // 선점: 같은 알림을 두 번 보내지 않도록 pending → sending 을 조건부로 바꾼 쪽만 보낸다.
  if (!ctx.db.run("UPDATE notifications SET status = 'sending', attempts = attempts + 1 WHERE id = :id AND status = 'pending'", { id: n.id })) return;

  const incident = ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = :id', { id: n.incidentId })!;
  const contact = n.contactId ? ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE id = :id', { id: n.contactId }) : undefined;
  const stale = n.purpose === 'contact_alert' && (!contact || !(CONFIRMED_STATUSES as readonly string[]).includes(incident.status));
  if (stale) {
    ctx.db.run("UPDATE notifications SET status = 'cancelled' WHERE id = :id", { id: n.id });
    return;
  }

  // 링크는 보낼 때 만든다. 토큰 원문은 문자에만 실리고 DB 에는 해시만 남는다.
  const body = n.body.includes('{link}') ? n.body.replace('{link}', createShareLink(ctx, { riderId: incident.riderId, contactId: contact!.id, incidentId: incident.id }).url) : n.body;
  try {
    await ctx.providers.sms.send(n.recipient, body);
    const sentAt = ctx.clock.now();
    ctx.db.tx(() => {
      ctx.db.run("UPDATE notifications SET status = 'sent', sentAt = :sentAt, error = NULL WHERE id = :id", { id: n.id, sentAt });
      if (n.purpose === 'contact_alert' && contact) {
        ctx.db.run('INSERT INTO incidentEvents (incidentId, type, at, dataJson) VALUES (:incidentId, :type, :at, :dataJson)', {
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
      ctx.db.run("UPDATE notifications SET status = 'pending', dueAt = :dueAt, error = :message WHERE id = :id", {
        id: n.id,
        dueAt: ctx.clock.now() + RETRY_BASE_MS * attempts,
        message,
      });
    } else {
      ctx.log.error(`문자 발송 최종 실패 → ${n.recipient}`, error);
      ctx.db.tx(() => {
        ctx.db.run("UPDATE notifications SET status = 'failed', error = :message WHERE id = :id", { id: n.id, message });
        ctx.db.run('INSERT INTO incidentEvents (incidentId, type, at, dataJson) VALUES (:incidentId, :type, :at, :dataJson)', {
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
export function recoverOutbox(ctx: AppContext) {
  ctx.db.run("UPDATE notifications SET status = 'pending' WHERE status = 'sending'");
}

export function startScheduler(ctx: AppContext, intervalMs = 1000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDue(ctx);
    } catch (error) {
      ctx.log.error('스케줄러 오류', error);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
