import type {
  EscalationReason,
  IncidentDetailDto,
  IncidentLocation,
  IncidentStep,
  IncidentSummaryDto,
  MedicalInfo,
  OpsEmergencyResponse,
  OpsIncidentDetailDto,
  OpsIncidentDto,
  OrderDto,
  Resolution,
  RiderResponse,
  Vehicle,
} from '@rider-guard/contract';

import type { AppContext, ContactRow, IncidentEventRow, IncidentRow, NotificationRow, OrderRow, RiderRow } from '../context.ts';
import { parseJson } from '../db.ts';
import { ApiError, formatPhone, iso, newId, notFound, seoulClock } from '../lib.ts';
import { consentsOf, displayName, getRider, listContacts } from './riders.ts';
import { enqueuePush } from './push.ts';
import { activeSession, latestLocation } from './sessions.ts';
import { CONFIRMED_STATUSES, OPEN_STATUSES, logLocationAccess } from './sharing.ts';

/** 늦게 도착한 감지 이벤트로 지금 경보를 울리지 않는다. */
const MAX_EVENT_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
/** 위치를 함께 보내지 않은 감지 이벤트는 이 시간 안의 최신 위치를 쓴다. */
const LOCATION_FRESH_MS = 2 * 60_000;

const isOpen = (s: IncidentRow['status']) => (OPEN_STATUSES as readonly string[]).includes(s);
const isConfirmed = (s: IncidentRow['status']) => (CONFIRMED_STATUSES as readonly string[]).includes(s);

// ── 조회 ───────────────────────────────────────────────────────

export async function openIncident(ctx: AppContext, riderId: string): Promise<IncidentRow | undefined> {
  return await ctx.db.get<IncidentRow>("SELECT * FROM incidents WHERE riderId = :riderId AND status IN ('countdown', 'escalated', 'reviewing')", {
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

async function addEvent(ctx: AppContext, incidentId: string, type: string, data: Record<string, unknown> | null = null) {
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
  /** 판정 근거 (지표·규칙 추적). 관제가 사고를 판단할 때 본다 */
  evidence?: unknown;
  /** 같은 보고를 두 번 받아도 사고를 한 번만 여는 키. 이미 끝난 사고라도 다시 열지 않는다 */
  reportKey?: string;
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
  if (detectedAt > now + CLOCK_SKEW_MS || detectedAt < now - MAX_EVENT_AGE_MS) {
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
      urgent: 0,
      riderResponse: null,
      respondedAt: null,
      escalationReason: null,
      escalatedAt: null,
      operatorName: null,
      reviewingAt: null,
      resolution: null,
      resolutionNote: null,
      resolvedAt: null,
      lat: input.location?.lat ?? fallback?.lat ?? null,
      lng: input.location?.lng ?? fallback?.lng ?? null,
      accuracy: input.location?.accuracy ?? fallback?.accuracy ?? null,
      locationAt: input.location ? now : (fallback?.recordedAt ?? null),
      address: null,
      metricsJson: input.metrics ? JSON.stringify(input.metrics) : null,
      sensorLogJson: null,
      evidenceJson: input.evidence === undefined ? null : JSON.stringify(input.evidence),
      reportKey: input.reportKey ?? null,
    };
    await ctx.db.run(
      `INSERT INTO incidents (${Object.keys(incident).join(', ')}) VALUES (${Object.keys(incident)
        .map((k) => `:${k}`)
        .join(', ')})`,
      incident,
    );
    await addEvent(ctx, incident.id, 'detected', { source: incident.source, kind: incident.kind });
    // 앱이 꺼져 있어도 확인 화면을 띄울 수 있게 (앱이 켜져 있으면 3초 폴링이 먼저 띄운다)
    await enqueuePush(ctx, incident, 'incident_detected');
    return { created: true, incident };
  });
}

// ── 라이더 응답 ────────────────────────────────────────────────

/**
 * 카운트다운 중: 괜찮아요 → 오탐 종료, 도움 요청 → 즉시 에스컬레이션.
 * 에스컬레이션 이후의 '괜찮아요'는 사고를 닫지 않는다 — "괜찮음을 기계에게 증명하게 하지 말고 사람이 판단한다"(6.4).
 * 남은 연락처 문자는 멈추고, 이미 받은 연락처에는 안심 문자를 보내고, 종료는 상담원이 확인 후 결정한다.
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
        await ctx.db.run("UPDATE incidents SET riderResponse = 'help', respondedAt = :now, urgent = 1 WHERE id = :id", { id, now });
        await addEvent(ctx, id, 'rider_help', { seconds: secondsSince(incident.detectedAt, now) });
        await escalate(ctx, await reload(ctx, id), 'rider_requested');
      }
      return await reload(ctx, id);
    }

    if (isConfirmed(incident.status)) {
      if (response === 'ok') {
        await ctx.db.run("UPDATE incidents SET riderResponse = 'ok', respondedAt = :now WHERE id = :id", { id, now });
        await addEvent(ctx, id, 'rider_ok_after_escalation');
        await cancelPendingAlerts(ctx, id);
        await queueContactUpdate(ctx, incident, `${displayName(await getRider(ctx, riderId))}님이 괜찮다고 응답했어요. 관제센터가 한 번 더 확인하고 있어요.`);
      } else {
        await ctx.db.run("UPDATE incidents SET riderResponse = 'help', respondedAt = :now, urgent = 1 WHERE id = :id", { id, now });
        await addEvent(ctx, id, 'rider_help');
      }
      return await reload(ctx, id);
    }

    throw new ApiError(409, 'incident_closed', '이미 종료된 사고예요.');
  });
}

const secondsSince = (from: number, now: number) => Math.max(0, Math.round((now - from) / 1000));

// ── 2·3단계: 에스컬레이션 (비상연락 문자 + 관제 접수) ─────────

/**
 * 카운트다운 만료 또는 도움 요청 시 호출된다. 조건부 UPDATE 로 한 번만 실행된다.
 * 문자·배차 요청은 여기서 보내지 않고 outbox(notifications, orders.reassignRequestedAt)에 넣어
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
    const body = `[Rider Guard] ${what} 현재 위치: {link} 위급해 보이면 119에 신고해 주세요. 관제센터 ${ctx.config.centerPhone}`;

    // 1순위부터 순서대로. 앞 순위가 링크에서 '확인'을 누르면 뒤 순위 문자는 취소된다.
    const contacts = await listContacts(ctx, incident.riderId);
    for (const [i, c] of contacts.entries()) {
      await insertNotification(ctx, incident.id, c, 'contact_alert', body, now + i * ctx.config.contactStaggerSeconds * 1000);
    }
    if (contacts.length === 0) await addEvent(ctx, incident.id, 'no_contacts');

    const order = await ctx.db.get<OrderRow>(
      "SELECT * FROM orders WHERE riderId = :riderId AND status = 'assigned' ORDER BY createdAt DESC LIMIT 1",
      { riderId: incident.riderId },
    );
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

async function insertNotification(ctx: AppContext, incidentId: string, contact: Pick<ContactRow, 'id' | 'phone'>, purpose: NotificationRow['purpose'], body: string, dueAt: number) {
  await ctx.db.run(
    `INSERT INTO notifications (id, incidentId, contactId, purpose, recipient, body, dueAt, status, attempts)
     VALUES (:id, :incidentId, :contactId, :purpose, :recipient, :body, :dueAt, 'pending', 0)`,
    { id: newId('ntf'), incidentId, contactId: contact.id, purpose, recipient: contact.phone, body, dueAt },
  );
}

async function cancelPendingAlerts(ctx: AppContext, incidentId: string) {
  await ctx.db.run("UPDATE notifications SET status = 'cancelled' WHERE incidentId = :incidentId AND purpose = 'contact_alert' AND status = 'pending'", {
    incidentId,
  });
}

/** 이미 사고 문자를 받은 연락처에게만 후속 안내를 보낸다. */
async function queueContactUpdate(ctx: AppContext, incident: IncidentRow, message: string) {
  const recipients = await ctx.db.all<{ contactId: string; recipient: string }>(
    "SELECT DISTINCT contactId, recipient FROM notifications WHERE incidentId = :incidentId AND purpose = 'contact_alert' AND status = 'sent'",
    { incidentId: incident.id },
  );
  for (const r of recipients) await insertNotification(ctx, incident.id, { id: r.contactId, phone: r.recipient }, 'contact_update', `[Rider Guard] ${message}`, ctx.clock.now());
}

// ── 3·4단계: 관제 상담원 ───────────────────────────────────────

/** 관제는 사고가 확정된 뒤에만 볼 수 있다 (4.1.2 '관제·센터: 사고 확정 시에만'). */
async function opsIncident(ctx: AppContext, id: string): Promise<IncidentRow> {
  const incident = await ctx.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = :id AND escalatedAt IS NOT NULL', { id });
  if (!incident) throw notFound('사고');
  return incident;
}

export async function claimIncident(ctx: AppContext, id: string, operator: string): Promise<IncidentRow> {
  return await ctx.db.tx(async () => {
    const incident = await opsIncident(ctx, id);
    if (incident.status === 'reviewing' && incident.operatorName !== operator) {
      throw new ApiError(409, 'already_claimed', `${incident.operatorName} 상담원이 이미 확인 중이에요.`);
    }
    if (incident.status !== 'escalated' && incident.status !== 'reviewing') throw new ApiError(409, 'incident_closed', '이미 종료된 사고예요.');
    if (incident.status === 'escalated') {
      await ctx.db.run("UPDATE incidents SET status = 'reviewing', operatorName = :operator, reviewingAt = :now WHERE id = :id", {
        id,
        operator,
        now: ctx.clock.now(),
      });
      await addEvent(ctx, id, 'center_reviewing', { operator });
    }
    return await reload(ctx, id);
  });
}

/**
 * 4단계 119 신고. 상담원이 배정된 사고에서만 가능하다.
 * 119 문자 자동 발송이 꺼져 있으면(기본, 로드맵 Phase 2) 신고문만 만들어 주고 상담원이 전화로 신고한다.
 */
export async function reportEmergency(ctx: AppContext, id: string, operator: string): Promise<OpsEmergencyResponse> {
  const incident = await opsIncident(ctx, id);
  if (incident.status !== 'reviewing') throw new ApiError(409, 'not_claimed', '먼저 사고를 배정받아 주세요.');
  const alreadySent = (await eventsOf(ctx, id)).some((e) => e.type === 'emergency_reported' && parseJson<{ mode: string }>(e.dataJson)?.mode === 'sms');
  if (alreadySent) throw new ApiError(409, 'already_reported', '이미 119 문자 신고를 보냈어요.');

  const report = await emergencyReport(ctx, incident);
  const mode = ctx.config.enable119Sms ? 'sms' : 'manual';
  if (mode === 'sms') await ctx.providers.emergency.report(report);
  await addEvent(ctx, id, 'emergency_reported', { mode, operator });
  return { mode, report };
}

/** 자동 신고 문자 포함 항목 (4.3): 위치 좌표·주소, 차량 정보, 사전 등록 의료정보 */
async function emergencyReport(ctx: AppContext, incident: IncidentRow): Promise<string> {
  const rider = await getRider(ctx, incident.riderId);
  const loc = await incidentLocation(ctx, incident);
  const vehicle = parseJson<Vehicle>(rider.vehicleJson);
  const medical = (await consentsOf(ctx, rider.id)).medicalInfo ? parseJson<MedicalInfo>(rider.medicalJson) : null;
  const response =
    incident.riderResponse === 'help' ? '라이더가 도움 요청' : incident.escalationReason === 'no_response' ? `${incident.countdownSeconds}초간 라이더 무응답` : '라이더 응답 확인 중';
  return [
    '[Rider Guard 사고 신고] 이륜차 배달 라이더 사고 의심',
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

export async function resolveIncident(ctx: AppContext, id: string, operator: string, outcome: Resolution, note?: string): Promise<IncidentRow> {
  return await ctx.db.tx(async () => {
    const incident = await opsIncident(ctx, id);
    if (!isConfirmed(incident.status)) throw new ApiError(409, 'incident_closed', '이미 종료된 사고예요.');
    const now = ctx.clock.now();
    await ctx.db.run(
      `UPDATE incidents SET status = 'resolved', resolution = :outcome, resolutionNote = :note, resolvedAt = :now,
         operatorName = COALESCE(operatorName, :operator)
       WHERE id = :id`,
      { id, outcome, note: note ?? null, now, operator },
    );
    await addEvent(ctx, id, 'resolved', { outcome, operator });
    await cancelPendingAlerts(ctx, id);
    const name = displayName(await getRider(ctx, incident.riderId));
    await queueContactUpdate(
      ctx,
      incident,
      outcome === 'false_alarm' ? `${name}님 건은 관제센터 확인 결과 오탐으로 종료됐어요. 걱정을 끼쳐 죄송해요.` : `${name}님 사고 대응이 종료됐어요.`,
    );
    return await reload(ctx, id);
  });
}

export async function markOrderReassigned(ctx: AppContext, id: string, operator: string): Promise<IncidentRow> {
  return await ctx.db.tx(async () => {
    await opsIncident(ctx, id);
    const changed = await ctx.db.run("UPDATE orders SET status = 'reassigned', updatedAt = :now WHERE incidentId = :id AND status = 'held'", {
      id,
      now: ctx.clock.now(),
    });
    if (!changed) throw new ApiError(409, 'no_held_order', '보류 중인 주문이 없어요.');
    await addEvent(ctx, id, 'order_reassigned', { operator });
    return await reload(ctx, id);
  });
}

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
    state: closed ? 'skipped' : status === 'countdown' ? 'todo' : notified.length ? 'done' : noContacts ? 'skipped' : 'now',
    at: iso(notifiedEvents[0]?.at),
    detail: { notified, pending: count('pending', 'sending'), failed: count('failed'), acknowledgedBy: ack?.name ?? null, reason: noContacts ? 'no_contacts' : null },
  });

  // 관제센터
  steps.push({
    key: 'center',
    state: closed ? 'skipped' : status === 'countdown' ? 'todo' : status === 'resolved' ? 'done' : 'now',
    at: iso(status === 'resolved' ? incident.resolvedAt : status === 'reviewing' ? incident.reviewingAt : incident.escalatedAt),
    detail: {
      phase: status === 'countdown' || closed ? 'waiting' : status === 'escalated' ? 'queued' : status === 'reviewing' ? 'reviewing' : 'closed',
      outcome: incident.resolution && status === 'resolved' ? incident.resolution : null,
    },
  });

  const emergency = first('emergency_reported');
  if (emergency) steps.push({ key: 'emergency', state: 'done', at: iso(emergency.at), detail: { mode: data<{ mode: 'sms' | 'manual' }>(emergency)!.mode } });

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

// ── 관제 콘솔 DTO ──────────────────────────────────────────────

function toOpsDto(incident: IncidentRow, rider: RiderRow): OpsIncidentDto {
  return {
    id: incident.id,
    status: incident.status,
    urgent: incident.urgent === 1,
    rider: { name: displayName(rider), phone: formatPhone(rider.phone) },
    detectedAt: iso(incident.detectedAt),
    escalatedAt: iso(incident.escalatedAt),
    escalationReason: incident.escalationReason,
    riderResponse: incident.riderResponse,
    operatorName: incident.operatorName,
    resolution: incident.resolution,
  };
}

/** 처리 중인 사고 + 최근 하루 안에 종료된 사고. 위치는 목록에 싣지 않는다(열람 기록 대상이라 상세에서만). */
export async function listForOps(ctx: AppContext): Promise<OpsIncidentDto[]> {
  const rows = await ctx.db.all<IncidentRow & { riderPhone: string; riderName: string | null }>(
    `SELECT i.*, r.phone AS riderPhone, r.name AS riderName FROM incidents i JOIN riders r ON r.id = i.riderId
     WHERE i.status IN ('escalated', 'reviewing') OR (i.status = 'resolved' AND i.resolvedAt > :since)
     ORDER BY CASE WHEN i.status = 'resolved' THEN 1 ELSE 0 END, i.urgent DESC, i.escalatedAt`,
    { since: ctx.clock.now() - 24 * 3_600_000 },
  );
  return rows.map((row) => toOpsDto(row, { id: row.riderId, phone: row.riderPhone, name: row.riderName } as RiderRow));
}

export async function opsDetail(ctx: AppContext, id: string, operator: string): Promise<OpsIncidentDetailDto> {
  const incident = await opsIncident(ctx, id);
  const rider = await getRider(ctx, incident.riderId);
  const location = await incidentLocation(ctx, incident);
  if (location && isOpen(incident.status)) {
    await logLocationAccess(ctx, { riderId: rider.id, incidentId: id, accessorKey: `center:${operator}`, accessor: `관제센터 ${operator}`, purpose: 'incident' });
  }
  const notifications = await ctx.db.all<NotificationRow>(
    "SELECT * FROM notifications WHERE incidentId = :id AND purpose = 'contact_alert' AND status = 'sent'",
    { id },
  );
  const acks = await ctx.db.all<{ contactId: string; acknowledgedAt: number }>(
    'SELECT contactId, acknowledgedAt FROM shareLinks WHERE incidentId = :id AND acknowledgedAt IS NOT NULL',
    { id },
  );
  const order = await orderOf(ctx, id);
  const medical = (await consentsOf(ctx, rider.id)).medicalInfo ? parseJson<MedicalInfo>(rider.medicalJson) : null;
  return {
    ...toOpsDto(incident, rider),
    rider: { name: displayName(rider), phone: formatPhone(rider.phone), vehicle: parseJson<Vehicle>(rider.vehicleJson), medical },
    location,
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
  };
}
