import type {
  AccountDto,
  ConsentKey,
  Consents,
  ContactDto,
  CreateContactRequest,
  DeviceDto,
  MedicalInfo,
  MeDto,
  OnboardingRequest,
  Relation,
  RiderDto,
  ShareLevel,
  SocialProvider,
  UpdateContactRequest,
  Vehicle,
} from '@rider-guard/contract';

import type { AppContext, ContactRow, DeviceRow, RiderRow, SessionRow } from '../context.ts';
import { parseJson } from '../db.ts';
import { ApiError, iso, newId, notFound, seoulDayStart } from '../lib.ts';
import { ACTIVE_SESSION_SQL, driveSecondsToday, TODAY_SESSIONS_SQL, toSessionDto, type TodaySessionRow } from './sessions.ts';

export const CONSENT_VERSION = '2026-09';
export const CONSENT_KEYS: ConsentKey[] = ['locationSensor', 'shareOnIncident', 'insuranceRecords', 'medicalInfo'];
export const REQUIRED_CONSENTS: ConsentKey[] = ['locationSensor', 'shareOnIncident'];
const MAX_CONTACTS = 5;
/** 태그/detector 하트비트가 이 시간 안에 있으면 연결된 것으로 본다. */
const DEVICE_ONLINE_MS = 60_000;

// ── 라이더 ─────────────────────────────────────────────────────

export async function getRider(ctx: AppContext, riderId: string): Promise<RiderRow> {
  const rider = await ctx.db.get<RiderRow>('SELECT * FROM riders WHERE id = :riderId', { riderId });
  if (!rider) throw notFound('라이더');
  return rider;
}

export function toRiderDto(r: RiderRow): RiderDto {
  return { id: r.id, email: r.email, phone: r.phone, name: r.name, vehicle: parseJson<Vehicle>(r.vehicleJson), medical: parseJson<MedicalInfo>(r.medicalJson) };
}

/** 문자·119 신고문·운영 모니터에 쓰는 이름. 이름을 등록하지 않았으면 번호 뒷자리로 부른다. */
export const displayName = (r: Pick<RiderRow, 'name' | 'phone'>) => r.name ?? (r.phone ? `라이더(${r.phone.slice(-4)})` : '라이더');

/** 이름·휴대폰·필수 동의를 마쳤는가 — 운행(위치 수집)을 시작할 수 있는 조건 */
export async function isOnboarded(ctx: AppContext, rider: RiderRow): Promise<boolean> {
  return onboardedWith(rider, await consentsOf(ctx, rider.id));
}

const onboardedWith = (rider: RiderRow, consents: Consents) => !!rider.onboardedAt && !!rider.phone && REQUIRED_CONSENTS.every((k) => consents[k]);

/**
 * 가입 정보 입력. SNS·이메일 가입 직후 한 번 거치고, 나중에 다시 불러 이름·번호를 고칠 수도 있다.
 * 휴대폰 번호는 사고 때 119 신고문에 들어가는 연락처라 필수지만, MVP 에서는 인증하지 않는다.
 */
export async function onboard(ctx: AppContext, riderId: string, input: OnboardingRequest) {
  const missing = REQUIRED_CONSENTS.filter((k) => !input.consents[k as keyof OnboardingRequest['consents']]);
  if (missing.length) throw new ApiError(400, 'consent_required', '필수 동의 항목에 모두 동의해야 시작할 수 있어요.');
  await ctx.db.tx(async () => {
    const rider = await getRider(ctx, riderId);
    await ctx.db.run('UPDATE riders SET name = :name, phone = :phone, onboardedAt = COALESCE(onboardedAt, :now) WHERE id = :id', {
      id: rider.id,
      name: input.name,
      phone: input.phone,
      now: ctx.clock.now(),
    });
    await setConsents(ctx, riderId, input.consents);
  });
}

const IDENTITIES_SQL = 'SELECT provider FROM riderIdentities WHERE riderId = :riderId ORDER BY createdAt';

export async function accountOf(ctx: AppContext, rider: RiderRow): Promise<AccountDto> {
  return accountWith(rider, await ctx.db.all<{ provider: SocialProvider }>(IDENTITIES_SQL, { riderId: rider.id }));
}

const accountWith = (rider: RiderRow, identities: { provider: SocialProvider }[]): AccountDto => ({
  email: rider.email,
  hasPassword: !!rider.passwordHash,
  social: identities.map((i) => i.provider),
});

export async function updateRider(ctx: AppContext, riderId: string, patch: { name?: string; vehicle?: Vehicle | null; medical?: MedicalInfo | null }) {
  const rider = await getRider(ctx, riderId);
  if (patch.medical && !(await consentsOf(ctx, riderId)).medicalInfo) {
    throw new ApiError(403, 'consent_required', '의료정보는 민감정보라 별도 동의가 있어야 저장할 수 있어요.');
  }
  const next: RiderRow = {
    ...rider,
    name: patch.name !== undefined ? patch.name : rider.name,
    vehicleJson: patch.vehicle !== undefined ? (patch.vehicle ? JSON.stringify(patch.vehicle) : null) : rider.vehicleJson,
    medicalJson: patch.medical !== undefined ? (patch.medical ? JSON.stringify(patch.medical) : null) : rider.medicalJson,
  };
  await ctx.db.run('UPDATE riders SET name = :name, vehicleJson = :vehicleJson, medicalJson = :medicalJson WHERE id = :id', {
    id: riderId,
    name: next.name,
    vehicleJson: next.vehicleJson,
    medicalJson: next.medicalJson,
  });
  return next;
}

// ── 동의 ───────────────────────────────────────────────────────

const CONSENTS_SQL = 'SELECT key, granted FROM consents WHERE riderId = :riderId';

export async function consentsOf(ctx: AppContext, riderId: string): Promise<Consents> {
  return consentsFrom(await ctx.db.all<{ key: ConsentKey; granted: number }>(CONSENTS_SQL, { riderId }));
}

function consentsFrom(rows: { key: ConsentKey; granted: number }[]): Consents {
  const out = Object.fromEntries(CONSENT_KEYS.map((k) => [k, false])) as Consents;
  for (const r of rows) out[r.key] = r.granted === 1;
  return out;
}

export async function setConsents(ctx: AppContext, riderId: string, consents: Partial<Consents>) {
  const updatedAt = ctx.clock.now();
  for (const [key, granted] of Object.entries(consents)) {
    await ctx.db.run(
      `INSERT INTO consents (riderId, key, granted, version, updatedAt) VALUES (:riderId, :key, :granted, :version, :updatedAt)
       ON CONFLICT (riderId, key) DO UPDATE SET granted = excluded.granted, version = excluded.version, updatedAt = excluded.updatedAt`,
      { riderId, key, granted: !!granted, version: CONSENT_VERSION, updatedAt },
    );
  }
  // 의료정보 동의를 철회하면 저장된 의료정보도 지운다.
  if (consents.medicalInfo === false) await ctx.db.run('UPDATE riders SET medicalJson = NULL WHERE id = :riderId', { riderId });
}

// ── 비상연락망 ─────────────────────────────────────────────────

/** 공개 범위 기본값 (4.1.2): 가족 실시간, 동료 이상 감지 시, 그 외 사고 확정 시 */
export function defaultShareLevel(relation: Relation): ShareLevel {
  return relation === 'family' ? 'realtime' : relation === 'coworker' ? 'on_anomaly' : 'on_incident';
}

export async function listContacts(ctx: AppContext, riderId: string): Promise<ContactRow[]> {
  return await ctx.db.all<ContactRow>('SELECT * FROM contacts WHERE riderId = :riderId ORDER BY priority', { riderId });
}

export async function getContact(ctx: AppContext, riderId: string, id: string): Promise<ContactRow> {
  const contact = await ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE id = :id AND riderId = :riderId', { id, riderId });
  if (!contact) throw notFound('연락처');
  return contact;
}

export function toContactDto(c: ContactRow): ContactDto {
  return { id: c.id, priority: c.priority, name: c.name, relation: c.relation, phone: c.phone, shareLevel: c.shareLevel };
}

export async function createContact(ctx: AppContext, riderId: string, input: CreateContactRequest): Promise<ContactRow> {
  const rider = await getRider(ctx, riderId);
  if (input.phone === rider.phone) throw new ApiError(400, 'own_phone', '본인 번호는 비상연락처로 등록할 수 없어요.');
  return await ctx.db.tx(async () => {
    const count = (await listContacts(ctx, riderId)).length;
    if (count >= MAX_CONTACTS) throw new ApiError(409, 'too_many_contacts', `비상연락처는 ${MAX_CONTACTS}명까지 등록할 수 있어요.`);
    const contact: ContactRow = {
      id: newId('con'),
      riderId,
      priority: count + 1,
      name: input.name,
      relation: input.relation,
      phone: input.phone,
      shareLevel: input.shareLevel ?? defaultShareLevel(input.relation),
      createdAt: ctx.clock.now(),
    };
    await ctx.db.run(
      `INSERT INTO contacts (id, riderId, priority, name, relation, phone, shareLevel, createdAt)
       VALUES (:id, :riderId, :priority, :name, :relation, :phone, :shareLevel, :createdAt)`,
      contact,
    );
    return contact;
  });
}

export async function updateContact(ctx: AppContext, riderId: string, id: string, patch: UpdateContactRequest): Promise<ContactRow> {
  return await ctx.db.tx(async () => {
    const current = await getContact(ctx, riderId, id);
    const next: ContactRow = {
      ...current,
      name: patch.name ?? current.name,
      relation: patch.relation ?? current.relation,
      phone: patch.phone ?? current.phone,
      shareLevel: patch.shareLevel ?? current.shareLevel,
    };
    await ctx.db.run('UPDATE contacts SET name = :name, relation = :relation, phone = :phone, shareLevel = :shareLevel WHERE id = :id', {
      id,
      name: next.name,
      relation: next.relation,
      phone: next.phone,
      shareLevel: next.shareLevel,
    });
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      const others = (await listContacts(ctx, riderId)).filter((c) => c.id !== id);
      const at = Math.min(Math.max(patch.priority, 1), others.length + 1) - 1;
      await renumber(ctx, [...others.slice(0, at).map((c) => c.id), id, ...others.slice(at).map((c) => c.id)]);
      next.priority = at + 1;
    }
    return next;
  });
}

export async function deleteContact(ctx: AppContext, riderId: string, id: string) {
  await ctx.db.tx(async () => {
    await getContact(ctx, riderId, id);
    await ctx.db.run('DELETE FROM contacts WHERE id = :id', { id });
    await renumber(ctx, (await listContacts(ctx, riderId)).map((c) => c.id));
  });
}

async function renumber(ctx: AppContext, orderedIds: string[]) {
  for (const [i, id] of orderedIds.entries()) {
    await ctx.db.run('UPDATE contacts SET priority = :priority WHERE id = :id', { id, priority: i + 1 });
  }
}

// ── 감지 기기 ──────────────────────────────────────────────────

export async function riderDevice(ctx: AppContext, riderId: string): Promise<DeviceRow | undefined> {
  return await ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE riderId = :riderId', { riderId });
}

export function toDeviceDto(ctx: AppContext, d: DeviceRow): DeviceDto {
  const connected = d.lastSeenAt != null && ctx.clock.now() - d.lastSeenAt < DEVICE_ONLINE_MS;
  return { id: d.id, name: d.name, kind: d.kind, pairingCode: d.pairingCode, connected, battery: d.battery, lastSeenAt: iso(d.lastSeenAt) };
}

/** 기기에 표시된 페어링 코드로 연결한다. 라이더당 기기는 하나라 기존 기기는 해제된다. */
export async function pairDevice(ctx: AppContext, riderId: string, pairingCode: string): Promise<DeviceRow> {
  return await ctx.db.tx(async () => {
    const device = await ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE pairingCode = :pairingCode', { pairingCode });
    if (!device) throw new ApiError(404, 'invalid_pairing_code', '페어링 코드를 찾을 수 없어요. 기기에 표시된 6자리를 확인해 주세요.');
    if (device.riderId && device.riderId !== riderId) throw new ApiError(409, 'device_taken', '다른 라이더에게 연결된 기기예요.');
    const pairedAt = ctx.clock.now();
    await ctx.db.run('UPDATE devices SET riderId = NULL, pairedAt = NULL WHERE riderId = :riderId AND id <> :id', { riderId, id: device.id });
    await ctx.db.run('UPDATE devices SET riderId = :riderId, pairedAt = :pairedAt WHERE id = :id', { riderId, pairedAt, id: device.id });
    return { ...device, riderId, pairedAt };
  });
}

export async function unpairDevice(ctx: AppContext, riderId: string) {
  await ctx.db.run('UPDATE devices SET riderId = NULL, pairedAt = NULL WHERE riderId = :riderId', { riderId });
}

// ── 홈/설정 화면용 집계 ────────────────────────────────────────

/** 앱이 가장 자주 부르는 조회라(홈은 15초마다) 쿼리를 한 번에 보낸다 — 원격 DB 왕복 한 번 */
export async function buildMe(ctx: AppContext, riderId: string): Promise<MeDto> {
  const now = ctx.clock.now();
  const [riders, sessions, devices, identities, consentRows, contacts, todaySessions] = (await ctx.db.readMany([
    { sql: 'SELECT * FROM riders WHERE id = :riderId', params: { riderId } },
    { sql: ACTIVE_SESSION_SQL, params: { riderId } },
    { sql: 'SELECT * FROM devices WHERE riderId = :riderId', params: { riderId } },
    { sql: IDENTITIES_SQL, params: { riderId } },
    { sql: CONSENTS_SQL, params: { riderId } },
    { sql: 'SELECT * FROM contacts WHERE riderId = :riderId ORDER BY priority', params: { riderId } },
    { sql: TODAY_SESSIONS_SQL, params: { riderId, dayStart: seoulDayStart(now) } },
  ])) as [RiderRow[], SessionRow[], DeviceRow[], { provider: SocialProvider }[], { key: ConsentKey; granted: number }[], ContactRow[], TodaySessionRow[]];
  const rider = riders[0];
  if (!rider) throw notFound('라이더');
  const session = sessions[0];
  const device = devices[0];
  const consents = consentsFrom(consentRows);
  return {
    rider: toRiderDto(rider),
    account: accountWith(rider, identities),
    onboarded: onboardedWith(rider, consents),
    consents,
    contacts: contacts.map(toContactDto),
    device: device ? toDeviceDto(ctx, device) : null,
    session: session ? toSessionDto(session) : null,
    today: { driveSeconds: driveSecondsToday(todaySessions, now), asOf: iso(now) },
  };
}
