import type {
  AffiliationDto,
  AgencyBoardDto,
  AgencyIncidentDto,
  AgencyOrderDto,
  AgencyRiderDto,
  CreateAgencyOrderRequest,
  DeliveryPlatform,
  IncidentStatus,
  OrderStatus,
  Resolution,
} from '@rider-guard/contract';
import { randomInt } from 'node:crypto';

import type { AppContext, IncidentRow, OrderRow, RiderRow } from '../context.ts';
import { parseJson } from '../db.ts';
import { ApiError, iso, newId, notFound } from '../lib.ts';
import { addEvent, closeByAgency } from './incidents.ts';
import { getRider, isAdmin } from './riders.ts';
import { logLocationAccess } from './sharing.ts';

/**
 * 배달대행사 소속과 관제.
 * - 관제사가 대행사를 만들면 가입 코드(6자리)가 생긴다. 라이더는 그 코드로 소속되고, 다른 관제사도 같은 코드로 합류한다.
 * - 소속 = 보호(운행 세션) 중 위치와 사고를 그 대행사 관제에 보이는 데 동의 (가입 화면에서 알린다). 보호가 꺼져 있으면 위치는 보이지 않는다.
 * - 주문은 대행사 관제사가 플랫폼(배민·쿠팡이츠…)과 함께 배정한다. 사고가 나면 그 주문이 보류되고 관제사가 대체 배차한다.
 */

export const PLATFORMS: DeliveryPlatform[] = ['baemin', 'coupangeats', 'yogiyo', 'ddangyo', 'other'];
/** 헷갈리는 글자(0·O·1·I·L)는 뺀다 — 전화로 불러 줘도 틀리지 않게 */
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** 보호 중 위치로 보여 주는 최근 위치의 최대 나이 */
const LOCATION_FRESH_MS = 10 * 60_000;
const SENSOR_ONLINE_MS = 60_000;

type AgencyRow = { id: string; name: string; joinCode: string; staffCode: string | null; createdBy: string; createdAt: number };

const platformsOf = (r: Pick<RiderRow, 'platformsJson'>): DeliveryPlatform[] =>
  (parseJson<string[]>(r.platformsJson ?? null) ?? []).filter((p): p is DeliveryPlatform => PLATFORMS.includes(p as DeliveryPlatform));

const staffName = (r: Pick<RiderRow, 'name' | 'email'>) => r.name?.trim() || r.email?.split('@')[0] || '관제사';

/** 라이더 가입 코드 6자리 · 관제사 초대 코드 8자리. 두 코드는 서로 겹치지 않는다(길이가 다르다) */
async function uniqueCode(ctx: AppContext, length: 6 | 8): Promise<string> {
  for (;;) {
    const code = Array.from({ length }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    if (!(await ctx.db.get('SELECT 1 FROM agencies WHERE joinCode = :code OR staffCode = :code', { code }))) return code;
  }
}

export const normalizeJoinCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');

// ── 라이더: 소속 ───────────────────────────────────────────────

export async function affiliationOf(ctx: AppContext, rider: RiderRow): Promise<AffiliationDto | null> {
  if (rider.platformsJson == null && !rider.agencyId) return null;
  const agency = rider.agencyId ? await ctx.db.get<AgencyRow>('SELECT * FROM agencies WHERE id = :id', { id: rider.agencyId }) : undefined;
  const orders = await ctx.db.all<OrderRow>("SELECT * FROM orders WHERE riderId = :riderId AND status IN ('assigned', 'held') ORDER BY createdAt DESC", { riderId: rider.id });
  return {
    agency: agency ? { id: agency.id, name: agency.name } : null,
    platforms: platformsOf(rider),
    joinedAt: iso(rider.agencyJoinedAt ?? null),
    orders: orders.map((o) => ({ id: o.id, platform: (o.platform as DeliveryPlatform | null) ?? null, storeName: o.storeName, destination: o.destination, status: o.status })),
  };
}

/**
 * 소속 정하기. joinCode 가 있으면 그 대행사에 소속되고, null 이면 대행사 없이(플랫폼 직접 계약) 플랫폼만 남긴다. 빠져 있으면 소속은 그대로.
 * 배달기사는 라이더 가입 코드로, 관제사는 관제사 초대 코드로만 들어간다 — 라이더 코드를 아는 사람이 관제사로 합류해 다른 라이더 위치를 보지 못하게.
 * 진행 중인 주문이 있으면 대행사를 바꾸지 않는다 — 주문이 원래 대행사 관제에서 사라진다.
 */
export async function setAffiliation(ctx: AppContext, riderId: string, input: { joinCode?: string | null; platforms: DeliveryPlatform[] }) {
  const rider = await getRider(ctx, riderId);
  const staff = rider.role === 'dispatcher' || (await isAdmin(ctx, riderId));
  const column = staff ? 'staffCode' : 'joinCode';
  const agency = input.joinCode ? await ctx.db.get<AgencyRow>(`SELECT * FROM agencies WHERE ${column} = :code`, { code: normalizeJoinCode(input.joinCode) }) : undefined;
  if (input.joinCode && !agency) {
    throw new ApiError(
      404,
      'agency_not_found',
      staff ? '관제사 초대 코드에 맞는 배달대행사가 없어요. 라이더 가입 코드가 아니라 관제사 초대 코드를 넣어 주세요.' : '가입 코드에 맞는 배달대행사가 없어요. 관제사에게 코드를 다시 확인해 주세요.',
    );
  }
  // joinCode 가 빠져 있으면 소속은 그대로 두고 플랫폼만 바꾼다
  const nextAgencyId = input.joinCode === undefined ? (rider.agencyId ?? null) : (agency?.id ?? null);
  if (nextAgencyId !== (rider.agencyId ?? null)) {
    const busy = await ctx.db.get("SELECT 1 FROM orders WHERE riderId = :riderId AND status IN ('assigned', 'held') LIMIT 1", { riderId });
    if (busy) throw new ApiError(409, 'orders_in_progress', '진행 중인 주문을 마친 뒤에 소속을 바꿀 수 있어요.');
  }
  const platforms = [...new Set(input.platforms)].filter((p) => PLATFORMS.includes(p));
  await ctx.db.run(
    `UPDATE riders SET agencyId = :agencyId, platformsJson = :platforms,
       agencyJoinedAt = CASE WHEN :agencyId IS NULL THEN NULL WHEN agencyId IS :agencyId THEN agencyJoinedAt ELSE :now END
     WHERE id = :riderId`,
    { riderId, agencyId: nextAgencyId, platforms: JSON.stringify(platforms), now: ctx.clock.now() },
  );
}

// ── 관제사: 대행사 ─────────────────────────────────────────────

/** 관제 화면을 쓸 수 있는 사람 — 관제사 역할이거나 관리자 */
async function requireDispatcher(ctx: AppContext, riderId: string): Promise<RiderRow> {
  const me = await getRider(ctx, riderId);
  if (me.role !== 'dispatcher' && !(await isAdmin(ctx, riderId))) throw new ApiError(403, 'dispatcher_only', '관제사만 쓸 수 있어요.');
  return me;
}

async function requireAgency(ctx: AppContext, riderId: string): Promise<{ me: RiderRow; agency: AgencyRow }> {
  const me = await requireDispatcher(ctx, riderId);
  const agency = me.agencyId ? await ctx.db.get<AgencyRow>('SELECT * FROM agencies WHERE id = :id', { id: me.agencyId }) : undefined;
  if (!agency) throw new ApiError(409, 'no_agency', '먼저 배달대행사를 등록하거나 가입 코드로 합류해 주세요.');
  return { me, agency };
}

export async function createAgency(ctx: AppContext, riderId: string, name: string): Promise<AgencyRow> {
  const me = await requireDispatcher(ctx, riderId);
  if (me.agencyId) throw new ApiError(409, 'already_in_agency', '이미 소속된 배달대행사가 있어요.');
  const now = ctx.clock.now();
  const agency: AgencyRow = { id: newId('agc'), name: name.trim(), joinCode: await uniqueCode(ctx, 6), staffCode: await uniqueCode(ctx, 8), createdBy: riderId, createdAt: now };
  await ctx.db.tx(async () => {
    await ctx.db.run('INSERT INTO agencies (id, name, joinCode, staffCode, createdBy, createdAt) VALUES (:id, :name, :joinCode, :staffCode, :createdBy, :createdAt)', agency);
    await ctx.db.run('UPDATE riders SET agencyId = :agencyId, agencyJoinedAt = :now WHERE id = :riderId', { riderId, agencyId: agency.id, now });
  });
  return agency;
}

/** 대행사 소속 라이더(관제사 제외) */
const MEMBERS_SQL = "SELECT * FROM riders WHERE agencyId = :agencyId AND (role IS NULL OR role = 'rider') ORDER BY name";

/** 관제 화면 한 장 — 소속 라이더, 진행 중 주문, 진행 중·최근 하루 사고 */
export async function agencyBoard(ctx: AppContext, riderId: string): Promise<AgencyBoardDto> {
  const me = await requireDispatcher(ctx, riderId);
  const agency = me.agencyId ? await ctx.db.get<AgencyRow>('SELECT * FROM agencies WHERE id = :id', { id: me.agencyId }) : undefined;
  if (!agency) return { agency: null, riders: [], orders: [], incidents: [] };
  // v10 이전에 만든 대행사는 관제사 초대 코드가 없다 — 처음 열 때 만든다
  if (!agency.staffCode) {
    agency.staffCode = await uniqueCode(ctx, 8);
    await ctx.db.run('UPDATE agencies SET staffCode = :code WHERE id = :id AND staffCode IS NULL', { code: agency.staffCode, id: agency.id });
  }
  const now = ctx.clock.now();
  const [members, sessions, devices, orders, incidents, acks] = (await ctx.db.readMany([
    { sql: MEMBERS_SQL, params: { agencyId: agency.id } },
    { sql: 'SELECT s.riderId FROM sessions s JOIN riders r ON r.id = s.riderId WHERE r.agencyId = :agencyId AND s.endedAt IS NULL AND s.expiresAt > :now', params: { agencyId: agency.id, now } },
    { sql: 'SELECT d.riderId, d.lastSensorAt FROM devices d JOIN riders r ON r.id = d.riderId WHERE r.agencyId = :agencyId', params: { agencyId: agency.id } },
    {
      sql: `SELECT o.*, r.name AS riderName FROM orders o JOIN riders r ON r.id = o.riderId
            WHERE o.agencyId = :agencyId AND (o.status IN ('assigned', 'held') OR o.updatedAt > :since) ORDER BY o.createdAt DESC LIMIT 100`,
      params: { agencyId: agency.id, since: now - 24 * 3_600_000 },
    },
    {
      sql: `SELECT i.*, r.name AS riderName, r.phone AS riderPhone FROM incidents i JOIN riders r ON r.id = i.riderId
            WHERE r.agencyId = :agencyId
            ORDER BY CASE WHEN i.status IN ('countdown', 'escalated') THEN 0 ELSE 1 END, i.detectedAt DESC LIMIT 30`,
      params: { agencyId: agency.id },
    },
    {
      sql: `SELECT e.incidentId, e.at, e.dataJson FROM incidentEvents e JOIN incidents i ON i.id = e.incidentId JOIN riders r ON r.id = i.riderId
            WHERE r.agencyId = :agencyId AND e.type = 'agency_ack'`,
      params: { agencyId: agency.id },
    },
  ])) as [
    RiderRow[],
    { riderId: string }[],
    { riderId: string; lastSensorAt: number | null }[],
    (OrderRow & { riderName: string | null })[],
    (IncidentRow & { riderName: string | null; riderPhone: string | null })[],
    { incidentId: string; at: number; dataJson: string | null }[],
  ];

  const protecting = new Set(sessions.map((s) => s.riderId));
  const sensor = new Map(devices.map((d) => [d.riderId, d.lastSensorAt]));
  const openByRider = new Map(incidents.filter((i) => i.status === 'countdown' || i.status === 'escalated').map((i) => [i.riderId, i.id]));
  const recentIncidents = incidents.filter((i) => i.status === 'countdown' || i.status === 'escalated' || (i.resolvedAt ?? i.respondedAt ?? i.detectedAt) > now - 24 * 3_600_000);

  const riders: AgencyRiderDto[] = [];
  for (const r of members) {
    const on = protecting.has(r.id);
    // 위치는 보호 중일 때만 — 소속 때 동의한 범위다. 볼 때마다 위치 이용 기록을 남긴다(같은 관제사는 10분에 한 번)
    const loc = on
      ? await ctx.db.get<{ lat: number; lng: number; recordedAt: number }>(
          'SELECT lat, lng, recordedAt FROM locations WHERE riderId = :riderId AND recordedAt >= :since ORDER BY recordedAt DESC LIMIT 1',
          { riderId: r.id, since: now - LOCATION_FRESH_MS },
        )
      : undefined;
    if (loc) {
      await logLocationAccess(ctx, {
        riderId: r.id,
        incidentId: openByRider.get(r.id) ?? null,
        accessorKey: `agency:${agency.id}:${me.id}`,
        accessor: `${agency.name} 관제 (${staffName(me)})`,
        purpose: openByRider.has(r.id) ? 'incident' : 'standing',
      });
    }
    const lastSensorAt = sensor.get(r.id);
    riders.push({
      id: r.id,
      name: r.name?.trim() || '이름 없음',
      phone: r.phone,
      platforms: platformsOf(r),
      protecting: on,
      location: loc ? { lat: loc.lat, lng: loc.lng, recordedAt: iso(loc.recordedAt) } : null,
      sensorOnline: on && lastSensorAt != null && now - lastSensorAt < SENSOR_ONLINE_MS,
      openIncidentId: openByRider.get(r.id) ?? null,
    });
  }

  const ackOf = new Map(acks.map((a) => [a.incidentId, { by: parseJson<{ by?: string }>(a.dataJson)?.by ?? '관제사', at: iso(a.at) }]));
  return {
    agency: { id: agency.id, name: agency.name, joinCode: agency.joinCode, staffCode: agency.staffCode },
    riders,
    orders: orders.map(toAgencyOrder),
    incidents: recentIncidents.map(
      (i): AgencyIncidentDto => ({
        id: i.id,
        riderId: i.riderId,
        riderName: i.riderName?.trim() || '이름 없음',
        riderPhone: i.riderPhone,
        status: i.status as IncidentStatus,
        detectedAt: iso(i.detectedAt),
        escalatedAt: iso(i.escalatedAt),
        escalationReason: i.escalationReason,
        riderResponse: i.riderResponse,
        resolution: i.resolution as Resolution | null,
        location: i.lat != null && i.lng != null ? { lat: i.lat, lng: i.lng } : null,
        ack: ackOf.get(i.id) ?? null,
      }),
    ),
  };
}

function toAgencyOrder(o: OrderRow & { riderName: string | null }): AgencyOrderDto {
  return {
    id: o.id,
    riderId: o.riderId,
    riderName: o.riderName?.trim() || '이름 없음',
    platform: (o.platform as DeliveryPlatform | null) ?? null,
    storeName: o.storeName,
    destination: o.destination,
    status: o.status as OrderStatus,
    incidentId: o.incidentId,
    createdAt: iso(o.createdAt),
  };
}

async function member(ctx: AppContext, agencyId: string, riderId: string): Promise<RiderRow> {
  const r = await ctx.db.get<RiderRow>("SELECT * FROM riders WHERE id = :riderId AND agencyId = :agencyId AND (role IS NULL OR role = 'rider')", { riderId, agencyId });
  if (!r) throw notFound('소속 라이더');
  return r;
}

async function agencyOrder(ctx: AppContext, agencyId: string, id: string): Promise<OrderRow> {
  const o = await ctx.db.get<OrderRow>('SELECT * FROM orders WHERE id = :id AND agencyId = :agencyId', { id, agencyId });
  if (!o) throw notFound('주문');
  return o;
}

async function agencyIncident(ctx: AppContext, agencyId: string, id: string): Promise<IncidentRow> {
  const i = await ctx.db.get<IncidentRow>('SELECT i.* FROM incidents i JOIN riders r ON r.id = i.riderId WHERE i.id = :id AND r.agencyId = :agencyId', { id, agencyId });
  if (!i) throw notFound('사고');
  return i;
}

/** 주문 배정 — 사고가 나면 이 주문이 보류된다 */
export async function assignOrder(ctx: AppContext, riderId: string, input: CreateAgencyOrderRequest): Promise<void> {
  const { agency } = await requireAgency(ctx, riderId);
  await member(ctx, agency.id, input.riderId);
  const now = ctx.clock.now();
  await ctx.db.run(
    `INSERT INTO orders (id, riderId, storeName, destination, status, incidentId, reassignRequestedAt, agencyId, platform, createdAt, updatedAt)
     VALUES (:id, :riderId, :storeName, :destination, 'assigned', NULL, NULL, :agencyId, :platform, :now, :now)`,
    { id: newId('ord'), riderId: input.riderId, storeName: input.storeName.trim(), destination: input.destination.trim(), agencyId: agency.id, platform: input.platform, now },
  );
}

export async function completeOrder(ctx: AppContext, riderId: string, orderId: string): Promise<void> {
  const { agency } = await requireAgency(ctx, riderId);
  const order = await agencyOrder(ctx, agency.id, orderId);
  if (order.status !== 'assigned') throw new ApiError(409, 'order_not_in_progress', '배달 중인 주문만 완료할 수 있어요.');
  await ctx.db.run("UPDATE orders SET status = 'delivered', updatedAt = :now WHERE id = :id AND status = 'assigned'", { id: order.id, now: ctx.clock.now() });
}

/** 사고로 보류된 주문을 다른 소속 라이더에게 넘긴다 */
export async function reassignOrder(ctx: AppContext, riderId: string, orderId: string, toRiderId: string): Promise<void> {
  const { me, agency } = await requireAgency(ctx, riderId);
  const order = await agencyOrder(ctx, agency.id, orderId);
  if (order.status !== 'held') throw new ApiError(409, 'order_not_held', '보류된 주문만 대체 배차할 수 있어요.');
  if (toRiderId === order.riderId) throw new ApiError(400, 'same_rider', '다른 라이더를 골라 주세요.');
  const to = await member(ctx, agency.id, toRiderId);
  await ctx.db.tx(async () => {
    const now = ctx.clock.now();
    if (!(await ctx.db.run("UPDATE orders SET status = 'reassigned', updatedAt = :now WHERE id = :id AND status = 'held'", { id: order.id, now }))) return;
    await ctx.db.run(
      `INSERT INTO orders (id, riderId, storeName, destination, status, incidentId, reassignRequestedAt, agencyId, platform, createdAt, updatedAt)
       VALUES (:id, :riderId, :storeName, :destination, 'assigned', NULL, NULL, :agencyId, :platform, :now, :now)`,
      { id: newId('ord'), riderId: to.id, storeName: order.storeName, destination: order.destination, agencyId: agency.id, platform: order.platform ?? null, now },
    );
    if (order.incidentId) await addEvent(ctx, order.incidentId, 'order_reassigned', { orderId: order.id, toRiderId: to.id, to: to.name, by: staffName(me) });
  });
}

/** 사고 접수 — 관제사가 맡았다는 표시. 라이더 앱과 사고 기록에 남는다 */
export async function ackIncident(ctx: AppContext, riderId: string, incidentId: string): Promise<void> {
  const { me, agency } = await requireAgency(ctx, riderId);
  const incident = await agencyIncident(ctx, agency.id, incidentId);
  if (incident.status !== 'countdown' && incident.status !== 'escalated') throw new ApiError(409, 'incident_closed', '이미 끝난 사고예요.');
  await ctx.db.tx(async () => {
    if (await ctx.db.get("SELECT 1 FROM incidentEvents WHERE incidentId = :id AND type = 'agency_ack'", { id: incident.id })) return;
    await addEvent(ctx, incident.id, 'agency_ack', { by: staffName(me), agency: agency.name });
  });
}

/** 대응 완료 — 에스컬레이션된 사고를 관제사가 닫는다. 라이더 확인 중(카운트다운)인 사고는 라이더 응답을 기다린다 */
export async function resolveIncident(ctx: AppContext, riderId: string, incidentId: string): Promise<void> {
  const { me, agency } = await requireAgency(ctx, riderId);
  const incident = await agencyIncident(ctx, agency.id, incidentId);
  if (incident.status !== 'escalated') throw new ApiError(409, 'incident_not_escalated', '라이더 확인이 끝난 뒤(대응 중인 사고)에만 완료할 수 있어요.');
  await closeByAgency(ctx, incident, staffName(me));
}
