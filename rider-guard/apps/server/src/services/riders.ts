import type {
  ConsentKey,
  Consents,
  ContactDto,
  CreateContactRequest,
  DeviceDto,
  MedicalInfo,
  MeDto,
  Relation,
  RiderDto,
  ShareLevel,
  UpdateContactRequest,
  Vehicle,
} from '@rider-guard/contract';

import type { AppContext, ContactRow, DeviceRow, RiderRow } from '../context.ts';
import { parseJson } from '../db.ts';
import { ApiError, iso, newId, notFound } from '../lib.ts';
import { activeSession, toSessionDto, todayDriveSeconds } from './sessions.ts';

export const CONSENT_VERSION = '2026-09';
export const CONSENT_KEYS: ConsentKey[] = ['locationSensor', 'shareOnIncident', 'insuranceRecords', 'medicalInfo'];
export const REQUIRED_CONSENTS: ConsentKey[] = ['locationSensor', 'shareOnIncident'];
const MAX_CONTACTS = 5;
/** 태그/detector 하트비트가 이 시간 안에 있으면 연결된 것으로 본다. */
const DEVICE_ONLINE_MS = 60_000;

// ── 라이더 ─────────────────────────────────────────────────────

export function getRider(ctx: AppContext, riderId: string): RiderRow {
  const rider = ctx.db.get<RiderRow>('SELECT * FROM riders WHERE id = :riderId', { riderId });
  if (!rider) throw notFound('라이더');
  return rider;
}

export function toRiderDto(r: RiderRow): RiderDto {
  return { id: r.id, phone: r.phone, name: r.name, vehicle: parseJson<Vehicle>(r.vehicleJson), medical: parseJson<MedicalInfo>(r.medicalJson) };
}

/** 문자·관제 화면에 쓰는 이름. 이름을 등록하지 않았으면 번호 뒷자리로 부른다. */
export const displayName = (r: RiderRow) => r.name ?? `라이더(${r.phone.slice(-4)})`;

export function updateRider(ctx: AppContext, riderId: string, patch: { name?: string; vehicle?: Vehicle | null; medical?: MedicalInfo | null }) {
  const rider = getRider(ctx, riderId);
  if (patch.medical && !consentsOf(ctx, riderId).medicalInfo) {
    throw new ApiError(403, 'consent_required', '의료정보는 민감정보라 별도 동의가 있어야 저장할 수 있어요.');
  }
  const next: RiderRow = {
    ...rider,
    name: patch.name !== undefined ? patch.name : rider.name,
    vehicleJson: patch.vehicle !== undefined ? (patch.vehicle ? JSON.stringify(patch.vehicle) : null) : rider.vehicleJson,
    medicalJson: patch.medical !== undefined ? (patch.medical ? JSON.stringify(patch.medical) : null) : rider.medicalJson,
  };
  ctx.db.run('UPDATE riders SET name = :name, vehicleJson = :vehicleJson, medicalJson = :medicalJson WHERE id = :id', {
    id: riderId,
    name: next.name,
    vehicleJson: next.vehicleJson,
    medicalJson: next.medicalJson,
  });
  return next;
}

// ── 동의 ───────────────────────────────────────────────────────

export function consentsOf(ctx: AppContext, riderId: string): Consents {
  const rows = ctx.db.all<{ key: ConsentKey; granted: number }>('SELECT key, granted FROM consents WHERE riderId = :riderId', { riderId });
  const out = Object.fromEntries(CONSENT_KEYS.map((k) => [k, false])) as Consents;
  for (const r of rows) out[r.key] = r.granted === 1;
  return out;
}

export function setConsents(ctx: AppContext, riderId: string, consents: Partial<Consents>) {
  const updatedAt = ctx.clock.now();
  for (const [key, granted] of Object.entries(consents)) {
    ctx.db.run(
      `INSERT INTO consents (riderId, key, granted, version, updatedAt) VALUES (:riderId, :key, :granted, :version, :updatedAt)
       ON CONFLICT (riderId, key) DO UPDATE SET granted = excluded.granted, version = excluded.version, updatedAt = excluded.updatedAt`,
      { riderId, key, granted: !!granted, version: CONSENT_VERSION, updatedAt },
    );
  }
  // 의료정보 동의를 철회하면 저장된 의료정보도 지운다.
  if (consents.medicalInfo === false) ctx.db.run('UPDATE riders SET medicalJson = NULL WHERE id = :riderId', { riderId });
}

// ── 비상연락망 ─────────────────────────────────────────────────

/** 공개 범위 기본값 (4.1.2): 가족 실시간, 동료 이상 감지 시, 그 외 사고 확정 시 */
export function defaultShareLevel(relation: Relation): ShareLevel {
  return relation === 'family' ? 'realtime' : relation === 'coworker' ? 'on_anomaly' : 'on_incident';
}

export function listContacts(ctx: AppContext, riderId: string): ContactRow[] {
  return ctx.db.all<ContactRow>('SELECT * FROM contacts WHERE riderId = :riderId ORDER BY priority', { riderId });
}

export function getContact(ctx: AppContext, riderId: string, id: string): ContactRow {
  const contact = ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE id = :id AND riderId = :riderId', { id, riderId });
  if (!contact) throw notFound('연락처');
  return contact;
}

export function toContactDto(c: ContactRow): ContactDto {
  return { id: c.id, priority: c.priority, name: c.name, relation: c.relation, phone: c.phone, shareLevel: c.shareLevel };
}

export function createContact(ctx: AppContext, riderId: string, input: CreateContactRequest): ContactRow {
  const rider = getRider(ctx, riderId);
  if (input.phone === rider.phone) throw new ApiError(400, 'own_phone', '본인 번호는 비상연락처로 등록할 수 없어요.');
  return ctx.db.tx(() => {
    const count = listContacts(ctx, riderId).length;
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
    ctx.db.run(
      `INSERT INTO contacts (id, riderId, priority, name, relation, phone, shareLevel, createdAt)
       VALUES (:id, :riderId, :priority, :name, :relation, :phone, :shareLevel, :createdAt)`,
      contact,
    );
    return contact;
  });
}

export function updateContact(ctx: AppContext, riderId: string, id: string, patch: UpdateContactRequest): ContactRow {
  return ctx.db.tx(() => {
    const current = getContact(ctx, riderId, id);
    const next: ContactRow = {
      ...current,
      name: patch.name ?? current.name,
      relation: patch.relation ?? current.relation,
      phone: patch.phone ?? current.phone,
      shareLevel: patch.shareLevel ?? current.shareLevel,
    };
    ctx.db.run('UPDATE contacts SET name = :name, relation = :relation, phone = :phone, shareLevel = :shareLevel WHERE id = :id', {
      id,
      name: next.name,
      relation: next.relation,
      phone: next.phone,
      shareLevel: next.shareLevel,
    });
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      const others = listContacts(ctx, riderId).filter((c) => c.id !== id);
      const at = Math.min(Math.max(patch.priority, 1), others.length + 1) - 1;
      renumber(ctx, [...others.slice(0, at).map((c) => c.id), id, ...others.slice(at).map((c) => c.id)]);
      next.priority = at + 1;
    }
    return next;
  });
}

export function deleteContact(ctx: AppContext, riderId: string, id: string) {
  ctx.db.tx(() => {
    getContact(ctx, riderId, id);
    ctx.db.run('DELETE FROM contacts WHERE id = :id', { id });
    renumber(ctx, listContacts(ctx, riderId).map((c) => c.id));
  });
}

function renumber(ctx: AppContext, orderedIds: string[]) {
  orderedIds.forEach((id, i) => ctx.db.run('UPDATE contacts SET priority = :priority WHERE id = :id', { id, priority: i + 1 }));
}

// ── 감지 기기 ──────────────────────────────────────────────────

export function riderDevice(ctx: AppContext, riderId: string): DeviceRow | undefined {
  return ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE riderId = :riderId', { riderId });
}

export function toDeviceDto(ctx: AppContext, d: DeviceRow): DeviceDto {
  const connected = d.lastSeenAt != null && ctx.clock.now() - d.lastSeenAt < DEVICE_ONLINE_MS;
  return { id: d.id, name: d.name, kind: d.kind, pairingCode: d.pairingCode, connected, battery: d.battery, lastSeenAt: iso(d.lastSeenAt) };
}

/** 기기에 표시된 페어링 코드로 연결한다. 라이더당 기기는 하나라 기존 기기는 해제된다. */
export function pairDevice(ctx: AppContext, riderId: string, pairingCode: string): DeviceRow {
  return ctx.db.tx(() => {
    const device = ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE pairingCode = :pairingCode', { pairingCode });
    if (!device) throw new ApiError(404, 'invalid_pairing_code', '페어링 코드를 찾을 수 없어요. 기기에 표시된 6자리를 확인해 주세요.');
    if (device.riderId && device.riderId !== riderId) throw new ApiError(409, 'device_taken', '다른 라이더에게 연결된 기기예요.');
    const pairedAt = ctx.clock.now();
    ctx.db.run('UPDATE devices SET riderId = NULL, pairedAt = NULL WHERE riderId = :riderId AND id <> :id', { riderId, id: device.id });
    ctx.db.run('UPDATE devices SET riderId = :riderId, pairedAt = :pairedAt WHERE id = :id', { riderId, pairedAt, id: device.id });
    return { ...device, riderId, pairedAt };
  });
}

export function unpairDevice(ctx: AppContext, riderId: string) {
  ctx.db.run('UPDATE devices SET riderId = NULL, pairedAt = NULL WHERE riderId = :riderId', { riderId });
}

// ── 홈/설정 화면용 집계 ────────────────────────────────────────

export function buildMe(ctx: AppContext, riderId: string): MeDto {
  const rider = getRider(ctx, riderId);
  const session = activeSession(ctx, riderId);
  const device = riderDevice(ctx, riderId);
  return {
    rider: toRiderDto(rider),
    consents: consentsOf(ctx, riderId),
    contacts: listContacts(ctx, riderId).map(toContactDto),
    device: device ? toDeviceDto(ctx, device) : null,
    session: session ? toSessionDto(session) : null,
    today: { driveSeconds: todayDriveSeconds(ctx, riderId), asOf: iso(ctx.clock.now()) },
    centerPhone: ctx.config.centerPhone,
  };
}
