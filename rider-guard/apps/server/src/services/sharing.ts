import type { LocationAccessDto } from '@rider-guard/contract';

import type { AppContext, ContactRow, IncidentRow, LocationRow, RiderRow, ShareLinkRow } from '../context.ts';
import { iso, newToken, sha256 } from '../lib.ts';
import { activeSession, latestLocation } from './sessions.ts';
import { consentsOf } from './riders.ts';

/** 사고 문자 링크 유효 기간. 응답 없는 사고도 이 기간 동안 열어 둔다 (incidents.ts INCIDENT_AUTO_CLOSE_MS). */
export const INCIDENT_LINK_TTL_MS = 24 * 3_600_000;
const STANDING_LINK_TTL_MS = 30 * 24 * 3_600_000;
/** 같은 사람이 링크를 새로고침할 때마다 이용내역이 쌓이지 않게 묶는 간격 */
const ACCESS_LOG_DEDUPE_MS = 5 * 60_000;
const RELATION_LABEL = { family: '가족', coworker: '동료', other: '지인' } as const;

export const OPEN_STATUSES = ['countdown', 'escalated'] as const;
export const CONFIRMED_STATUSES = ['escalated'] as const;

export async function createShareLink(ctx: AppContext, input: { riderId: string; contactId: string; incidentId: string | null }) {
  const token = newToken();
  const now = ctx.clock.now();
  const row: ShareLinkRow = {
    tokenHash: sha256(token),
    riderId: input.riderId,
    contactId: input.contactId,
    incidentId: input.incidentId,
    scope: input.incidentId ? 'incident' : 'standing',
    createdAt: now,
    expiresAt: now + (input.incidentId ? INCIDENT_LINK_TTL_MS : STANDING_LINK_TTL_MS),
    acknowledgedAt: null,
  };
  await ctx.db.run(
    `INSERT INTO shareLinks (tokenHash, riderId, contactId, incidentId, scope, createdAt, expiresAt, acknowledgedAt)
     VALUES (:tokenHash, :riderId, :contactId, :incidentId, :scope, :createdAt, :expiresAt, :acknowledgedAt)`,
    row,
  );
  return { url: `${ctx.config.publicBaseUrl}/s/${token}`, expiresAt: row.expiresAt };
}

export type ShareView =
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | {
      kind: 'ok';
      link: ShareLinkRow;
      rider: RiderRow;
      contact: ContactRow;
      incident: IncidentRow | null;
      /** 지금 이 사람에게 위치를 보여줘도 되는지. 안 되면 location 은 null. */
      visible: boolean;
      location: { lat: number; lng: number; accuracy: number | null; recordedAt: number } | null;
    };

/**
 * 링크를 연 사람에게 위치를 보여줄 수 있는지 판단한다 (4.1.2 공유 대상 분리 권한).
 * - 사고 링크: 그 사고가 확정(escalated) 상태인 동안
 * - 상시 링크: 연락처의 공개 범위에 따라 — 실시간(운행 중) / 이상 감지 시 / 사고 확정 시
 */
export async function viewShareLink(ctx: AppContext, token: string): Promise<ShareView> {
  const link = await ctx.db.get<ShareLinkRow>('SELECT * FROM shareLinks WHERE tokenHash = :tokenHash', { tokenHash: sha256(token) });
  if (!link) return { kind: 'invalid' };
  if (link.expiresAt <= ctx.clock.now()) return { kind: 'expired' };
  const rider = await ctx.db.get<RiderRow>('SELECT * FROM riders WHERE id = :id', { id: link.riderId });
  const contact = await ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE id = :id', { id: link.contactId });
  if (!rider || !contact || contact.riderId !== rider.id || !(await consentsOf(ctx, rider.id)).shareOnIncident) return { kind: 'invalid' };

  const incident = link.incidentId
    ? ((await ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = :id', { id: link.incidentId })) ?? null)
    : ((await ctx.db.get<IncidentRow>(
        `SELECT * FROM incidents WHERE riderId = :riderId AND status IN ('countdown', 'escalated')`,
        { riderId: rider.id },
      )) ?? null);

  if (incident && incident.riderId !== rider.id) return { kind: 'invalid' };
  const confirmed = !!incident && (CONFIRMED_STATUSES as readonly string[]).includes(incident.status);
  const anomaly = !!incident && (OPEN_STATUSES as readonly string[]).includes(incident.status);
  const session = await activeSession(ctx, rider.id);
  const visible =
    link.scope === 'incident'
      ? confirmed
      : contact.shareLevel === 'realtime'
        ? !!session || anomaly
        : contact.shareLevel === 'on_anomaly'
          ? anomaly
          : confirmed;

  let location: Extract<ShareView, { kind: 'ok' }>['location'] = null;
  if (visible) {
    // 사고 중에는 감지 10분 전 이후의 최신 위치, 평상시에는 이번 운행의 최신 위치
    const since = incident && anomaly ? incident.detectedAt - 10 * 60_000 : (session?.startedAt ?? Number.MAX_SAFE_INTEGER);
    const latest: LocationRow | undefined = await latestLocation(ctx, rider.id, since);
    if (latest) location = { lat: latest.lat, lng: latest.lng, accuracy: latest.accuracy, recordedAt: latest.recordedAt };
    else if (incident?.lat != null && incident.lng != null)
      location = { lat: incident.lat, lng: incident.lng, accuracy: incident.accuracy, recordedAt: incident.locationAt ?? incident.detectedAt };
    if (location) {
      await logLocationAccess(ctx, {
        riderId: rider.id,
        incidentId: incident && anomaly ? incident.id : null,
        accessorKey: `contact:${contact.id}`,
        accessor: `${contact.priority}순위 ${contact.name} (${RELATION_LABEL[contact.relation]})`,
        purpose: link.scope,
      });
    }
  }
  return { kind: 'ok', link, rider, contact, incident, visible, location };
}

/** 문자를 받은 연락처가 '확인했어요'를 누름 → 다음 순위에게는 보내지 않는다. */
export async function acknowledgeShareLink(ctx: AppContext, token: string): Promise<boolean> {
  return respondToShareLink(ctx, token, 'acknowledged');
}

/** Responses describe the recipient's action, never an automatic emergency-service delivery. */
export async function respondToShareLink(ctx: AppContext, token: string, response: 'acknowledged' | 'unreachable' | 'reported_119'): Promise<boolean> {
  return ctx.db.tx(async () => {
  const view = await viewShareLink(ctx, token);
  if (view.kind !== 'ok' || view.link.scope !== 'incident' || !view.incident || !view.visible) return false;
  const now = ctx.clock.now();
  const incidentId = view.incident.id;
  const type = `contact_${response}`;
  const previous = await ctx.db.get('SELECT 1 FROM incidentEvents WHERE incidentId = :incidentId AND type = :type AND json_extract(dataJson, \'$.contactId\') = :contactId', { incidentId, type, contactId: view.contact.id });
  if (previous) return true;
  if (response !== 'unreachable') {
    const changed = await ctx.db.run('UPDATE shareLinks SET acknowledgedAt = :now WHERE tokenHash = :tokenHash AND acknowledgedAt IS NULL', {
      now,
      tokenHash: view.link.tokenHash,
    });
    void changed;
    await ctx.db.run(
      "UPDATE notifications SET status = 'cancelled' WHERE incidentId = :incidentId AND purpose = 'contact_alert' AND status = 'pending'",
      { incidentId },
    );
  }
    await ctx.db.run('INSERT INTO incidentEvents (incidentId, type, at, dataJson) VALUES (:incidentId, :type, :at, :dataJson)', {
      incidentId,
      type,
      at: now,
      dataJson: JSON.stringify({ contactId: view.contact.id, priority: view.contact.priority, name: view.contact.name, reportedBy: 'recipient', automaticTransmission: false }),
    });
  return true;
  });
}

export async function logLocationAccess(
  ctx: AppContext,
  entry: { riderId: string; incidentId: string | null; accessorKey: string; accessor: string; purpose: 'incident' | 'standing' },
) {
  const now = ctx.clock.now();
  const recent = await ctx.db.get<{ id: number }>(
    'SELECT id FROM locationAccessLogs WHERE riderId = :riderId AND accessorKey = :accessorKey AND at > :since LIMIT 1',
    { riderId: entry.riderId, accessorKey: entry.accessorKey, since: now - ACCESS_LOG_DEDUPE_MS },
  );
  if (recent) return;
  await ctx.db.run(
    `INSERT INTO locationAccessLogs (riderId, incidentId, accessorKey, accessor, purpose, at)
     VALUES (:riderId, :incidentId, :accessorKey, :accessor, :purpose, :at)`,
    { ...entry, at: now },
  );
}

export async function listLocationAccess(ctx: AppContext, riderId: string): Promise<LocationAccessDto[]> {
  const rows = await ctx.db.all<{ at: number; accessor: string; purpose: 'incident' | 'standing'; incidentId: string | null }>(
    'SELECT at, accessor, purpose, incidentId FROM locationAccessLogs WHERE riderId = :riderId ORDER BY at DESC LIMIT 100',
    { riderId },
  );
  return rows.map((r) => ({ at: iso(r.at), accessor: r.accessor, purpose: r.purpose, incidentId: r.incidentId }));
}
