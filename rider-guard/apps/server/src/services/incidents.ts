import type {
  DetectionV1,
  EmergencyDelivery,
  EscalationReason,
  IncidentDetailDto,
  IncidentLocation,
  IncidentStep,
  IncidentSummaryDto,
  MedicalInfo,
  OpsIncidentDetailDto,
  OpsIncidentDto,
  OrderDto,
  Resolution,
  RiderResponse,
  StepState,
  Vehicle,
} from '@rider-guard/contract';

import type { AppContext, ContactRow, DetectionRow, IncidentEventRow, IncidentRow, NotificationRow, OrderRow, RiderRow } from '../context.ts';
import { parseJson } from '../db.ts';
import { ApiError, formatPhone, iso, newId, notFound, seoulClock } from '../lib.ts';
import { levelOf } from './levels.ts';
import { consentsOf, displayName, getRider, listContacts } from './riders.ts';
import { enqueuePush } from './push.ts';
import { activeSession, latestLocation } from './sessions.ts';
import { CONFIRMED_STATUSES, INCIDENT_LINK_TTL_MS } from './sharing.ts';

/** 늦게 도착한 감지 이벤트로 지금 경보를 울리지 않는다. */
const MAX_EVENT_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
/** 위치를 함께 보내지 않은 감지 이벤트는 이 시간 안의 최신 위치를 쓴다. */
const LOCATION_FRESH_MS = 2 * 60_000;
/**
 * 라이더가 끝내 응답하지 못한 사고를 닫기까지. 비상연락처가 받은 위치 링크가 살아 있는 동안은 열어 둔다 —
 * 사고가 닫히면 링크도 위치를 감추기 때문이다.
 */
export const INCIDENT_AUTO_CLOSE_MS = INCIDENT_LINK_TTL_MS;
/** 119 신고 문자의 수신자 표시 (실제 발송은 providers.emergency 가 한다) */
const EMERGENCY_RECIPIENT = '119';

const isConfirmed = (s: IncidentRow['status']) => (CONFIRMED_STATUSES as readonly string[]).includes(s);

// ── 조회 ───────────────────────────────────────────────────────

export async function openIncident(ctx: AppContext, riderId: string): Promise<IncidentRow | undefined> {
  return await ctx.db.get<IncidentRow>("SELECT * FROM incidents WHERE riderId = :riderId AND status IN ('countdown', 'escalated')", {
    riderId,
  });
}

export async function riderIncident(ctx: AppContext, riderId: string, id: string): Promise<IncidentRow> {
  const incident = await ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = :id AND riderId = :riderId', { id, riderId });
  if (!incident) throw notFound('사고 기록');
  return incident;
}

async function reload(ctx: AppContext, id: string): Promise<IncidentRow> {
  return (await ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = :id', { id }))!;
}

export async function addEvent(ctx: AppContext, incidentId: string, type: string, data: Record<string, unknown> | null = null) {
  await ctx.db.run('INSERT INTO incidentEvents (incidentId, type, at, dataJson) VALUES (:incidentId, :type, :at, :dataJson)', {
    incidentId,
    type,
    at: ctx.clock.now(),
    dataJson: data ? JSON.stringify(data) : null,
  });
}

async function eventsOf(ctx: AppContext, incidentId: string): Promise<IncidentEventRow[]> {
  return await ctx.db.all<IncidentEventRow>('SELECT * FROM incidentEvents WHERE incidentId = :incidentId ORDER BY id', { incidentId });
}

async function orderOf(ctx: AppContext, incidentId: string): Promise<OrderRow | undefined> {
  return await ctx.db.get<OrderRow>('SELECT * FROM orders WHERE incidentId = :incidentId', { incidentId });
}

// ── 1단계: 감지 → 취소 카운트다운 ──────────────────────────────

export type NewIncident = {
  riderId: string;
  source: IncidentRow['source'];
  kind: IncidentRow['kind'];
  detectedAt?: number;
  location?: { lat: number; lng: number; accuracy?: number };
  metrics?: Record<string, number>;
  deviceId?: string;
  /** 판정 근거 (지표·규칙 추적). 운영 모니터에서 임계값을 맞출 때 본다 */
  evidence?: unknown;
  /** 같은 보고를 두 번 받아도 사고를 한 번만 여는 키. 이미 끝난 사고라도 다시 열지 않는다 */
  reportKey?: string;
  /** 보류·대체배차할 주문. 없으면 에스컬레이션 때 라이더의 최근 배달 중 주문 */
  orderId?: string;
  /** 위치 대신 붙일 주소 표시 (데모 위치 등). 119 신고문에도 그대로 들어간다 */
  address?: string;
  /** 재생 데이터: 감지 시각이 합성 값이라 너무 오래됐거나 미래여도 받는다 */
  syntheticTime?: boolean;
  /** 타임라인 첫 줄(detected)에 덧붙일 내용 */
  detectedEvent?: Record<string, unknown>;
};

/**
 * 감지 이벤트로 사고를 연다. 운행 세션 밖의 감지는 받지 않는다 (5.5 '일상 동작' 오탐 제거).
 * 이미 진행 중인 사고가 있으면 새로 만들지 않고 그것을 돌려준다 — 같은 충격의 반복 트리거로 경보가 겹치지 않게.
 */
export async function createIncident(ctx: AppContext, input: NewIncident): Promise<{ created: boolean; incident: IncidentRow }> {
  const session = await activeSession(ctx, input.riderId);
  if (!session) throw new ApiError(409, 'no_active_session', '운행 중에만 사고 감지가 동작해요.');

  const now = ctx.clock.now();
  const detectedAt = input.detectedAt ?? now;
  if (!input.syntheticTime && (detectedAt > now + CLOCK_SKEW_MS || detectedAt < now - MAX_EVENT_AGE_MS)) {
    throw new ApiError(422, 'stale_event', '감지 시각이 너무 오래됐거나 미래예요.');
  }

  return await ctx.db.tx(async () => {
    if (input.reportKey) {
      const same = await ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE riderId = :riderId AND reportKey = :reportKey', {
        riderId: input.riderId,
        reportKey: input.reportKey,
      });
      if (same) return { created: false, incident: same };
    }
    const existing = await openIncident(ctx, input.riderId);
    if (existing) return { created: false, incident: existing };

    const fallback = input.location ? undefined : await latestLocation(ctx, input.riderId, now - LOCATION_FRESH_MS);
    const incident: IncidentRow = {
      id: newId('inc'),
      riderId: input.riderId,
      sessionId: session.id,
      deviceId: input.deviceId ?? null,
      source: input.source,
      kind: input.kind,
      detectedAt,
      receivedAt: now,
      countdownSeconds: ctx.config.countdownSeconds,
      // 카운트다운은 앱에 경보가 뜨는 시점(서버 수신)부터 센다. 전달이 늦어도 라이더의 응답 시간을 깎지 않는다.
      deadlineAt: now + ctx.config.countdownSeconds * 1000,
      status: 'countdown',
      riderResponse: null,
      respondedAt: null,
      escalationReason: null,
      escalatedAt: null,
      resolution: null,
      resolvedAt: null,
      lat: input.location?.lat ?? fallback?.lat ?? null,
      lng: input.location?.lng ?? fallback?.lng ?? null,
      accuracy: input.location?.accuracy ?? fallback?.accuracy ?? null,
      locationAt: input.location ? now : (fallback?.recordedAt ?? null),
      address: input.location ? (input.address ?? null) : null,
      metricsJson: input.metrics ? JSON.stringify(input.metrics) : null,
      sensorLogJson: null,
      evidenceJson: input.evidence === undefined ? null : JSON.stringify(input.evidence),
      reportKey: input.reportKey ?? null,
      orderId: input.orderId ?? null,
    };
    await ctx.db.run(
      `INSERT INTO incidents (${Object.keys(incident).join(', ')}) VALUES (${Object.keys(incident)
        .map((k) => `:${k}`)
        .join(', ')})`,
      incident,
    );
    await addEvent(ctx, incident.id, 'detected', { source: incident.source, kind: incident.kind, ...input.detectedEvent });
    // 앱이 꺼져 있어도 확인 화면을 띄울 수 있게 (앱이 켜져 있으면 3초 폴링이 먼저 띄운다)
    await enqueuePush(ctx, incident, 'incident_detected');
    return { created: true, incident };
  });
}

// ── 라이더 응답 ────────────────────────────────────────────────

/**
 * 카운트다운 중: 괜찮아요 → 오탐 종료, 도움 요청 → 즉시 에스컬레이션.
 * 에스컬레이션 이후: 괜찮아요 → 사고 종료 (남은 문자·119 신고 취소, 이미 알린 연락처와 119 에는 무사하다고 알림).
 * 관제 상담원이 없으므로 설계문서 6.4 의 '사람이 판단' 대신 라이더 본인의 응답을 따른다.
 * 도움 요청 → 이미 119 에 신고했으면 후속 문자로 알린다.
 */
export async function respond(ctx: AppContext, riderId: string, id: string, response: RiderResponse): Promise<IncidentRow> {
  return await ctx.db.tx(async () => {
    const incident = await riderIncident(ctx, riderId, id);
    const now = ctx.clock.now();

    if (incident.status === 'countdown') {
      if (response === 'ok') {
        await ctx.db.run(
          `UPDATE incidents SET status = 'cancelled', riderResponse = 'ok', respondedAt = :now, resolution = 'false_alarm', resolvedAt = :now
           WHERE id = :id`,
          { id, now },
        );
        await addEvent(ctx, id, 'rider_ok', { seconds: secondsSince(incident.detectedAt, now) });
      } else {
        await ctx.db.run("UPDATE incidents SET riderResponse = 'help', respondedAt = :now WHERE id = :id", { id, now });
        await addEvent(ctx, id, 'rider_help', { seconds: secondsSince(incident.detectedAt, now) });
        await escalate(ctx, await reload(ctx, id), 'rider_requested');
      }
      return await reload(ctx, id);
    }

    if (isConfirmed(incident.status)) {
      if (response === 'ok') {
        await ctx.db.run("UPDATE incidents SET riderResponse = 'ok', respondedAt = :now WHERE id = :id", { id, now });
        await addEvent(ctx, id, 'rider_ok_after_escalation');
        await closeIncident(ctx, incident, 'rider_ok');
      } else if (incident.riderResponse !== 'help') {
        await ctx.db.run("UPDATE incidents SET riderResponse = 'help', respondedAt = :now WHERE id = :id", { id, now });
        await addEvent(ctx, id, 'rider_help');
        await updateEmergencyReport(ctx, await reload(ctx, id), '라이더가 앱에서 직접 도움을 요청했어요.');
      }
      return await reload(ctx, id);
    }

    throw new ApiError(409, 'incident_closed', '이미 종료된 사고예요.');
  });
}

const secondsSince = (from: number, now: number) => Math.max(0, Math.round((now - from) / 1000));

// ── 2·3·4단계: 에스컬레이션 (비상연락 문자 + 119 자동 신고 + 대체배차) ─

/**
 * 카운트다운 만료 또는 도움 요청 시 호출된다. 조건부 UPDATE 로 한 번만 실행된다.
 * 관제 상담원 없이 여기서 대응을 전부 건다. 카운트다운(30~60초)이 이미 오탐을 거르는 유예라 119 도 곧바로 신고한다.
 * 문자·119·배차 요청은 여기서 보내지 않고 outbox(notifications, orders.reassignRequestedAt)에 넣어
 * 스케줄러가 보낸다 — 외부 호출이 실패하거나 서버가 재시작돼도 다시 시도할 수 있게.
 */
export async function escalate(ctx: AppContext, incident: IncidentRow, reason: EscalationReason): Promise<boolean> {
  return await ctx.db.tx(async () => {
    const now = ctx.clock.now();
    const changed = await ctx.db.run(
      "UPDATE incidents SET status = 'escalated', escalationReason = :reason, escalatedAt = :now WHERE id = :id AND status = 'countdown'",
      { id: incident.id, reason, now },
    );
    if (!changed) return false;
    await addEvent(ctx, incident.id, 'escalated', { reason });
    // 도움 요청은 라이더가 방금 앱에서 누른 것이라 알릴 필요가 없다.
    if (reason === 'no_response') await enqueuePush(ctx, incident, 'escalated');

    const rider = await getRider(ctx, incident.riderId);
    const name = displayName(rider);
    const what =
      reason === 'rider_requested'
        ? `${name}님이 사고 후 도움을 요청했어요.`
        : `${name}님에게 사고가 감지됐고 ${incident.countdownSeconds}초 동안 응답이 없었어요.`;
    const body = `[Rider Guard] ${what} 현재 위치: {link} 119에도 자동으로 신고해요.`;

    // 1순위부터 순서대로. 앞 순위가 링크에서 '확인'을 누르면 뒤 순위 문자는 취소된다.
    const contacts = await listContacts(ctx, incident.riderId);
    for (const [i, c] of contacts.entries()) {
      await insertNotification(ctx, incident.id, c, 'contact_alert', body, now + i * ctx.config.contactStaggerSeconds * 1000);
    }
    if (contacts.length === 0) await addEvent(ctx, incident.id, 'no_contacts');

    const report = await emergencyReport(ctx, { ...incident, escalationReason: reason });
    await insertNotification(ctx, incident.id, { id: null, phone: EMERGENCY_RECIPIENT }, 'emergency_report', report, now);

    // 보내는 쪽이 사고 당시 주문을 알려 줬으면 그 주문, 아니면 라이더의 최근 배달 중 주문
    const order = incident.orderId
      ? await ctx.db.get<OrderRow>("SELECT * FROM orders WHERE id = :id AND riderId = :riderId AND status = 'assigned'", {
          id: incident.orderId,
          riderId: incident.riderId,
        })
      : await ctx.db.get<OrderRow>("SELECT * FROM orders WHERE riderId = :riderId AND status = 'assigned' ORDER BY createdAt DESC LIMIT 1", {
          riderId: incident.riderId,
        });
    if (order) {
      await ctx.db.run("UPDATE orders SET status = 'held', incidentId = :incidentId, updatedAt = :now WHERE id = :id", {
        id: order.id,
        incidentId: incident.id,
        now,
      });
      await addEvent(ctx, incident.id, 'order_held', { orderId: order.id });
    }
    return true;
  });
}

async function insertNotification(
  ctx: AppContext,
  incidentId: string,
  contact: { id: ContactRow['id'] | null; phone: string },
  purpose: NotificationRow['purpose'],
  body: string,
  dueAt: number,
) {
  await ctx.db.run(
    `INSERT INTO notifications (id, incidentId, contactId, purpose, recipient, body, dueAt, status, attempts)
     VALUES (:id, :incidentId, :contactId, :purpose, :recipient, :body, :dueAt, 'pending', 0)`,
    { id: newId('ntf'), incidentId, contactId: contact.id, purpose, recipient: contact.phone, body, dueAt },
  );
}

/** 아직 나가지 않은 비상연락 문자와 119 신고를 멈춘다. */
async function cancelPendingAlerts(ctx: AppContext, incidentId: string) {
  await ctx.db.run(
    "UPDATE notifications SET status = 'cancelled' WHERE incidentId = :incidentId AND purpose IN ('contact_alert', 'emergency_report') AND status = 'pending'",
    { incidentId },
  );
}

/** 이미 사고 문자를 받은 연락처에게만 후속 안내를 보낸다. */
export async function queueContactUpdate(ctx: AppContext, incident: IncidentRow, message: string) {
  const recipients = await ctx.db.all<{ contactId: string; recipient: string }>(
    "SELECT DISTINCT contactId, recipient FROM notifications WHERE incidentId = :incidentId AND purpose = 'contact_alert' AND status = 'sent'",
    { incidentId: incident.id },
  );
  for (const r of recipients) await insertNotification(ctx, incident.id, { id: r.contactId, phone: r.recipient }, 'contact_update', `[Rider Guard] ${message}`, ctx.clock.now());
}

// ── 사고 종료 ──────────────────────────────────────────────────

/**
 * 119 신고 뒤 라이더 상태가 바뀌면 알린다. 아직 보내기 전이면 신고문을 새로 쓰고, 보냈거나 보내는 중이면 후속 문자를 보낸다.
 * 신고가 끝내 실패했거나 취소됐으면 아무것도 하지 않는다 — 신고를 못 받은 119 에 후속만 가면 혼란스럽다.
 */
async function updateEmergencyReport(ctx: AppContext, incident: IncidentRow, what: string) {
  const report = await ctx.db.get<Pick<NotificationRow, 'id' | 'status'>>(
    "SELECT id, status FROM notifications WHERE incidentId = :incidentId AND purpose = 'emergency_report'",
    { incidentId: incident.id },
  );
  if (report?.status === 'pending') {
    await ctx.db.run('UPDATE notifications SET body = :body WHERE id = :id', { id: report.id, body: await emergencyReport(ctx, incident) });
  } else if (report?.status === 'sending' || report?.status === 'sent') {
    const rider = await getRider(ctx, incident.riderId);
    const body = `[Rider Guard 후속] ${seoulClock(ctx.clock.now())} 앞서 자동 신고한 ${displayName(rider)} ${formatPhone(rider.phone)} 사고 건 — ${what}`;
    await insertNotification(ctx, incident.id, { id: null, phone: EMERGENCY_RECIPIENT }, 'emergency_update', body, ctx.clock.now());
  }
}

/**
 * 에스컬레이션된 사고를 닫는다 — 라이더의 '괜찮아요'(rider_ok) 또는 24시간 경과(handled).
 * 조건부 UPDATE 라 동시에 불려도 한 번만 닫힌다.
 */
async function closeIncident(ctx: AppContext, incident: IncidentRow, outcome: Exclude<Resolution, 'false_alarm'>): Promise<boolean> {
  return await ctx.db.tx(async () => {
    const now = ctx.clock.now();
    const changed = await ctx.db.run(
      "UPDATE incidents SET status = 'resolved', resolution = :outcome, resolvedAt = :now WHERE id = :id AND status = 'escalated'",
      { id: incident.id, outcome, now },
    );
    if (!changed) return false;
    await addEvent(ctx, incident.id, 'resolved', { outcome });
    await cancelPendingAlerts(ctx, incident.id);
    // 라이더가 괜찮다고 했으면 이미 알린 곳에도 알린다. 24시간 자동 종료는 알리지 않는다 — 하루 뒤 문자는 소음이다.
    if (outcome === 'rider_ok') {
      await updateEmergencyReport(ctx, incident, "라이더 본인이 앱에서 '괜찮다'고 응답했어요.");
      const name = displayName(await getRider(ctx, incident.riderId));
      await queueContactUpdate(ctx, incident, `${name}님이 괜찮다고 응답해서 사고 대응을 마쳤어요. 걱정을 끼쳐 죄송해요.`);
    }
    return true;
  });
}

/**
 * 재생·테스트 사고를 다음 재생이 대신한다 — 시연은 사고를 한 건씩 차례로 열고, 라이더당 진행 중 사고는 하나다.
 * 카운트다운 중이면 cancelled, 에스컬레이션 뒤면 resolved 로 닫는다. 결과는 앱 기록에서 '대응 완료'로 보이는 handled 를 쓴다
 * (앱을 다시 빌드하지 않으려고 새 값을 만들지 않았다). 실제 사고는 부르지 않는다.
 */
export async function supersedeIncident(ctx: AppContext, incident: IncidentRow, by: { detectionId: string }): Promise<boolean> {
  return await ctx.db.tx(async () => {
    const now = ctx.clock.now();
    const changed = await ctx.db.run(
      `UPDATE incidents SET status = CASE status WHEN 'countdown' THEN 'cancelled' ELSE 'resolved' END, resolution = 'handled', resolvedAt = :now
       WHERE id = :id AND status IN ('countdown', 'escalated') AND source = 'test'`,
      { id: incident.id, now },
    );
    if (!changed) return false;
    await addEvent(ctx, incident.id, 'superseded', { detectionId: by.detectionId });
    await cancelPendingAlerts(ctx, incident.id);
    return true;
  });
}

/** 라이더가 끝내 응답하지 못한 사고를 24시간 뒤 닫는다. 스케줄러의 정리 작업이 부른다. */
export async function closeStaleIncidents(ctx: AppContext): Promise<number> {
  // incidents_status(status, deadlineAt) 인덱스로 진행 중인 사고만 읽는다
  const stale = await ctx.db.all<IncidentRow>("SELECT * FROM incidents WHERE status = 'escalated' AND escalatedAt <= :cutoff", {
    cutoff: ctx.clock.now() - INCIDENT_AUTO_CLOSE_MS,
  });
  let closed = 0;
  for (const incident of stale) if (await closeIncident(ctx, incident, 'handled')) closed++;
  return closed;
}

// ── 119 자동 신고 ──────────────────────────────────────────────

/** 신고문 (4.3): 위치 좌표·주소, 차량 정보, 사전 등록 의료정보 */
async function emergencyReport(ctx: AppContext, incident: IncidentRow): Promise<string> {
  const rider = await getRider(ctx, incident.riderId);
  const loc = await incidentLocation(ctx, incident);
  const vehicle = parseJson<Vehicle>(rider.vehicleJson);
  const medical = (await consentsOf(ctx, rider.id)).medicalInfo ? parseJson<MedicalInfo>(rider.medicalJson) : null;
  const response = incident.riderResponse === 'help' ? '라이더가 도움 요청' : `${incident.countdownSeconds}초간 라이더 무응답`;
  return [
    '[Rider Guard 사고 자동 신고] 이륜차 배달 라이더 사고 의심',
    loc
      ? `위치: ${loc.address ?? '주소 미확인'} (위도 ${loc.lat.toFixed(6)}, 경도 ${loc.lng.toFixed(6)}${loc.accuracy != null ? `, 오차 ${Math.round(loc.accuracy)}m` : ''})`
      : '위치: 확인 불가',
    loc ? `지도: https://map.kakao.com/link/map/${encodeURIComponent('사고 위치')},${loc.lat},${loc.lng}` : null,
    `감지: ${seoulClock(incident.detectedAt)} ${incident.kind === 'fall' ? '전도' : '충격'} 감지 · ${response}`,
    `라이더: ${displayName(rider)} ${formatPhone(rider.phone)}`,
    vehicle && (vehicle.plate || vehicle.model) ? `차량: ${[vehicle.plate, vehicle.model].filter(Boolean).join(' ')}` : null,
    medical
      ? `의료정보: 혈액형 ${medical.bloodType || '-'} / 기저질환 ${medical.conditions || '-'} / 알레르기 ${medical.allergies || '-'}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 119 자동 신고가 어디까지 갔는가 — outbox 행으로 판단한다 */
export async function emergencyDelivery(ctx: AppContext, incident: IncidentRow): Promise<{ delivery: EmergencyDelivery; sentAt: number | null }> {
  const row = await ctx.db.get<Pick<NotificationRow, 'status' | 'attempts' | 'sentAt'>>(
    "SELECT status, attempts, sentAt FROM notifications WHERE incidentId = :incidentId AND purpose = 'emergency_report'",
    { incidentId: incident.id },
  );
  if (!row) return { delivery: incident.status === 'countdown' ? 'waiting' : 'cancelled', sentAt: null };
  return { delivery: row.status === 'pending' ? (row.attempts > 0 ? 'retrying' : 'sending') : row.status, sentAt: row.sentAt };
}

const EMERGENCY_STEP: Record<EmergencyDelivery, StepState> = {
  waiting: 'todo',
  sending: 'now',
  retrying: 'now',
  sent: 'done',
  // 끝내 실패하면 사람이 직접 신고해야 하는 일이 남아 있다
  failed: 'now',
  cancelled: 'skipped',
};

// ── 사후 기록 ──────────────────────────────────────────────────

/** 충격 전후 ±5초 원시 센서 데이터 (5.7). 보험·산재 증빙과 알고리즘 튜닝의 원본. */
export async function saveSensorLog(ctx: AppContext, riderId: string, id: string, log: unknown) {
  await riderIncident(ctx, riderId, id);
  await ctx.db.tx(async () => {
    await ctx.db.run('UPDATE incidents SET sensorLogJson = :json WHERE id = :id', { id, json: JSON.stringify(log) });
    await addEvent(ctx, id, 'sensor_log_saved');
  });
}

// ── DTO ────────────────────────────────────────────────────────

async function incidentLocation(ctx: AppContext, incident: IncidentRow): Promise<IncidentLocation | null> {
  if (incident.lat != null && incident.lng != null) {
    return { lat: incident.lat, lng: incident.lng, accuracy: incident.accuracy, address: incident.address, recordedAt: iso(incident.locationAt ?? incident.detectedAt) };
  }
  // 감지 순간 위치가 없으면 직전 10분 안의 최신 위치
  const latest = await latestLocation(ctx, incident.riderId, incident.detectedAt - 10 * 60_000);
  return latest ? { lat: latest.lat, lng: latest.lng, accuracy: latest.accuracy, address: null, recordedAt: iso(latest.recordedAt) } : null;
}

const toOrderDto = (o: OrderRow): OrderDto => ({ id: o.id, storeName: o.storeName, destination: o.destination, status: o.status });

export async function toDetailDto(ctx: AppContext, incident: IncidentRow): Promise<IncidentDetailDto> {
  const order = await orderOf(ctx, incident.id);
  return {
    id: incident.id,
    status: incident.status,
    source: incident.source,
    kind: incident.kind,
    detectedAt: iso(incident.detectedAt),
    countdownSeconds: incident.countdownSeconds,
    deadlineAt: iso(incident.deadlineAt),
    riderResponse: incident.riderResponse,
    respondedAt: iso(incident.respondedAt),
    escalationReason: incident.escalationReason,
    escalatedAt: iso(incident.escalatedAt),
    resolution: incident.resolution,
    resolvedAt: iso(incident.resolvedAt),
    location: await incidentLocation(ctx, incident),
    order: order ? toOrderDto(order) : null,
    steps: await buildSteps(ctx, incident, order),
    serverTime: iso(ctx.clock.now()),
  };
}

/** Status 화면의 '대응 단계'. 상태 판단은 서버가, 문구는 앱이 한다. */
async function buildSteps(ctx: AppContext, incident: IncidentRow, order: OrderRow | undefined): Promise<IncidentStep[]> {
  const events = await eventsOf(ctx, incident.id);
  const first = (type: string) => events.find((e) => e.type === type);
  const data = <T,>(e: IncidentEventRow | undefined) => parseJson<T>(e?.dataJson);
  const { status } = incident;
  const closed = status === 'cancelled';

  const steps: IncidentStep[] = [{ key: 'detected', state: 'done', at: iso(incident.detectedAt), detail: { source: incident.source, kind: incident.kind } }];

  // 라이더 응답 — 카운트다운 중 첫 응답(또는 무응답)
  const firstResponse = events.find((e) => e.type === 'rider_ok' || e.type === 'rider_help');
  if (firstResponse) {
    steps.push({
      key: 'response',
      state: 'done',
      at: iso(firstResponse.at),
      detail: { response: firstResponse.type === 'rider_ok' ? 'ok' : 'help', seconds: data<{ seconds: number }>(firstResponse)?.seconds ?? null },
    });
  } else if (incident.escalationReason === 'no_response') {
    steps.push({ key: 'response', state: 'done', at: iso(incident.escalatedAt), detail: { response: 'none', seconds: null } });
  } else {
    steps.push({ key: 'response', state: 'now', at: null, detail: { response: null, seconds: null } });
  }

  // 비상연락 문자
  const counts = await ctx.db.all<{ status: NotificationRow['status']; n: number }>(
    "SELECT status, COUNT(*) AS n FROM notifications WHERE incidentId = :id AND purpose = 'contact_alert' GROUP BY status",
    { id: incident.id },
  );
  const count = (...s: NotificationRow['status'][]) => counts.filter((c) => s.includes(c.status)).reduce((sum, c) => sum + c.n, 0);
  const notifiedEvents = events.filter((e) => e.type === 'contact_notified');
  const notified = notifiedEvents.map((e) => data<{ priority: number; name: string }>(e)!).map(({ priority, name }) => ({ priority, name }));
  const ack = data<{ name: string }>(first('contact_acknowledged'));
  const noContacts = !!first('no_contacts');
  steps.push({
    key: 'contacts',
    state: closed ? 'skipped' : status === 'countdown' ? 'todo' : notified.length ? 'done' : noContacts || status === 'resolved' ? 'skipped' : 'now',
    at: iso(notifiedEvents[0]?.at),
    detail: { notified, pending: count('pending', 'sending'), failed: count('failed'), acknowledgedBy: ack?.name ?? null, reason: noContacts ? 'no_contacts' : null },
  });

  // 119 자동 신고. 상담원이 신고하던 때의 기록은 outbox 행 없이 이벤트만 있다.
  const { delivery, sentAt } = await emergencyDelivery(ctx, incident);
  const legacy = delivery === 'cancelled' ? first('emergency_reported') : undefined;
  const emergency = legacy ? 'sent' : delivery;
  steps.push({ key: 'emergency', state: EMERGENCY_STEP[emergency], at: iso(sentAt ?? legacy?.at), detail: { delivery: emergency } });

  if (order) {
    const reassigned = first('order_reassigned');
    steps.push({ key: 'order', state: order.status === 'held' ? 'now' : 'done', at: iso(reassigned?.at ?? first('order_held')?.at), detail: { status: order.status } });
  }

  const finished = status === 'resolved' || status === 'cancelled';
  steps.push({ key: 'record', state: finished ? 'done' : 'todo', at: iso(finished ? incident.resolvedAt : null), detail: {} });
  return steps;
}

export async function listIncidentSummaries(ctx: AppContext, riderId: string): Promise<IncidentSummaryDto[]> {
  const rows = await ctx.db.all<IncidentRow>('SELECT * FROM incidents WHERE riderId = :riderId ORDER BY detectedAt DESC LIMIT 50', { riderId });
  const summaries: IncidentSummaryDto[] = [];
  for (const r of rows) {
    const notified = (
      await ctx.db.all<{ dataJson: string }>("SELECT dataJson FROM incidentEvents WHERE incidentId = :id AND type = 'contact_notified' ORDER BY id", {
        id: r.id,
      })
    ).map((e) => (JSON.parse(e.dataJson) as { priority: number }).priority);
    const order = await orderOf(ctx, r.id);
    const loc = r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng, address: r.address } : null;
    summaries.push({
      id: r.id,
      status: r.status,
      source: r.source,
      kind: r.kind,
      detectedAt: iso(r.detectedAt),
      riderResponse: r.riderResponse,
      responseSeconds: r.respondedAt != null ? secondsSince(r.detectedAt, r.respondedAt) : null,
      escalationReason: r.escalationReason,
      resolution: r.resolution,
      notifiedPriorities: notified,
      orderStatus: order?.status ?? null,
      location: loc,
    });
  }
  return summaries;
}

// ── 운영 모니터 DTO (읽기 전용) ─────────────────────────────────

function toOpsDto(ctx: AppContext, incident: IncidentRow, rider: Pick<RiderRow, 'name' | 'phone'>, detection: DetectionV1 | null): OpsIncidentDto {
  const level = detection ? levelOf(incident, detection, ctx.config.thresholds.stillQuietMinS) : null;
  const replay = detection?.source.replay;
  return {
    id: incident.id,
    status: incident.status,
    rider: { name: displayName(rider) },
    detectedAt: iso(incident.detectedAt),
    escalatedAt: iso(incident.escalatedAt),
    escalationReason: incident.escalationReason,
    riderResponse: incident.riderResponse,
    resolution: incident.resolution,
    level: level?.level ?? null,
    levelLabel: level?.label ?? null,
    replay: replay ? { runId: replay.run_id, scenarioName: replay.scenario_name } : null,
  };
}

/**
 * 대응 중인 사고 + 최근 하루 안에 종료된 사고. 카운트다운 중인 사고는 확정 전이라 보이지 않는다 (4.1.2).
 * 데모 모드는 시연 화면이라 라이더 확인 전(카운트다운)과 기각된 사고까지 보인다.
 */
export async function listForOps(ctx: AppContext): Promise<OpsIncidentDto[]> {
  const where = ctx.config.demoMode
    ? "i.status IN ('countdown', 'escalated') OR i.resolvedAt > :since"
    : "i.status = 'escalated' OR (i.status = 'resolved' AND i.resolvedAt > :since)";
  const rows = await ctx.db.all<IncidentRow & { riderPhone: string | null; riderName: string | null; detectionJson: string | null }>(
    `SELECT i.*, r.phone AS riderPhone, r.name AS riderName, d.bodyJson AS detectionJson
     FROM incidents i JOIN riders r ON r.id = i.riderId LEFT JOIN detections d ON d.incidentId = i.id
     WHERE ${where}
     ORDER BY CASE WHEN i.status IN ('countdown', 'escalated') THEN 0 ELSE 1 END, i.receivedAt DESC`,
    { since: ctx.clock.now() - 24 * 3_600_000 },
  );
  return rows.map((row) => toOpsDto(ctx, row, { phone: row.riderPhone, name: row.riderName }, parseJson<DetectionV1>(row.detectionJson)));
}

/** 자동 대응이 어디까지 갔는지와 판정 근거. 위치·연락처 번호·의료정보는 싣지 않으므로 위치 이용 기록 대상이 아니다. */
export async function opsDetail(ctx: AppContext, id: string): Promise<OpsIncidentDetailDto> {
  const incident = await ctx.db.get<IncidentRow>(
    `SELECT * FROM incidents WHERE id = :id${ctx.config.demoMode ? '' : ' AND escalatedAt IS NOT NULL'}`,
    { id },
  );
  if (!incident) throw notFound('사고');
  const rider = await getRider(ctx, incident.riderId);
  const detectionRow = await ctx.db.get<Pick<DetectionRow, 'bodyJson'>>('SELECT bodyJson FROM detections WHERE incidentId = :id', { id });
  const detection = parseJson<DetectionV1>(detectionRow?.bodyJson);
  const notifications = await ctx.db.all<NotificationRow>(
    "SELECT * FROM notifications WHERE incidentId = :id AND purpose = 'contact_alert' AND status = 'sent'",
    { id },
  );
  const acks = await ctx.db.all<{ contactId: string; acknowledgedAt: number }>(
    'SELECT contactId, acknowledgedAt FROM shareLinks WHERE incidentId = :id AND acknowledgedAt IS NOT NULL',
    { id },
  );
  const order = await orderOf(ctx, id);
  return {
    ...toOpsDto(ctx, incident, rider, detection),
    emergency: (await emergencyDelivery(ctx, incident)).delivery,
    contacts: (await listContacts(ctx, rider.id)).map((c) => ({
      priority: c.priority,
      name: c.name,
      relation: c.relation,
      notifiedAt: iso(notifications.find((n) => n.contactId === c.id)?.sentAt),
      acknowledgedAt: iso(acks.find((a) => a.contactId === c.id)?.acknowledgedAt),
    })),
    order: order ? toOrderDto(order) : null,
    timeline: (await eventsOf(ctx, id)).map((e) => ({ type: e.type, at: iso(e.at), data: parseJson<Record<string, unknown>>(e.dataJson) })),
    evidence: parseJson<unknown>(incident.evidenceJson),
    // 운영 모니터에는 위치를 싣지 않는다 — 좌표는 빼고 출처·표시(데모 위치 등)만
    detection: detection
      ? { ...detection, location: detection.location ? { source: detection.location.source ?? null, label: detection.location.label ?? null } : null }
      : null,
    stillnessMinS: ctx.config.thresholds.stillQuietMinS,
  };
}
