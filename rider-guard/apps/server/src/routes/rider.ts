import type {
  ActiveIncidentResponse,
  ContactDto,
  CreateIncidentResponse,
  DeviceDto,
  IncidentDetailDto,
  IncidentListResponse,
  LocationAccessDto,
  MeDto,
  OrderDto,
  OtpResponse,
  RiderDto,
  SessionDto,
  ShareLinkResponse,
  UploadLocationsResponse,
  VerifyResponse,
} from '@rider-guard/contract';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import type { AppContext, OrderRow } from '../context.ts';
import { ApiError, iso, mobileSchema, newId, readBody } from '../lib.ts';
import { requestOtp, revokeToken, riderIdForToken, verifyOtp } from '../services/auth.ts';
import {
  createIncident,
  listIncidentSummaries,
  openIncident,
  respond,
  riderIncident,
  saveSensorLog,
  toDetailDto,
} from '../services/incidents.ts';
import {
  buildMe,
  consentsOf,
  createContact,
  deleteContact,
  getContact,
  pairDevice,
  riderDevice,
  setConsents,
  toContactDto,
  toDeviceDto,
  toRiderDto,
  unpairDevice,
  updateContact,
  updateRider,
} from '../services/riders.ts';
import { addLocations, endSession, startSession, toSessionDto } from '../services/sessions.ts';
import { createShareLink, listLocationAccess } from '../services/sharing.ts';

export type RiderEnv = { Variables: { riderId: string } };

const relation = z.enum(['family', 'coworker', 'other']);
const shareLevel = z.enum(['realtime', 'on_anomaly', 'on_incident']);
const isoDate = z.iso.datetime({ offset: true });
const name = z.string().trim().min(1, '이름을 입력해 주세요.').max(20);

const schemas = {
  otp: z.object({ phone: mobileSchema }),
  verify: z.object({
    phone: mobileSchema,
    code: z.string().regex(/^\d{6}$/, '인증번호 6자리를 입력해 주세요.'),
    consents: z.object({ locationSensor: z.boolean(), shareOnIncident: z.boolean(), insuranceRecords: z.boolean() }),
  }),
  updateMe: z.object({
    name: name.optional(),
    vehicle: z.object({ plate: z.string().max(20).optional(), model: z.string().max(40).optional() }).nullable().optional(),
    medical: z
      .object({ bloodType: z.string().max(10).optional(), conditions: z.string().max(200).optional(), allergies: z.string().max(200).optional() })
      .nullable()
      .optional(),
  }),
  consent: z.object({ granted: z.boolean() }),
  createContact: z.object({ name, relation, phone: mobileSchema, shareLevel: shareLevel.optional() }),
  updateContact: z.object({
    name: name.optional(),
    relation: relation.optional(),
    phone: mobileSchema.optional(),
    shareLevel: shareLevel.optional(),
    priority: z.number().int().min(1).optional(),
  }),
  pair: z.object({
    pairingCode: z
      .string()
      .transform((s) => s.replace(/\s/g, ''))
      .pipe(z.string().regex(/^\d{6}$/, '페어링 코드 6자리를 입력해 주세요.')),
  }),
  locations: z.object({
    points: z
      .array(
        z.object({
          recordedAt: isoDate,
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          accuracy: z.number().nonnegative().optional(),
          speed: z.number().optional(),
          heading: z.number().optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
  createIncident: z.object({
    source: z.enum(['phone', 'tag', 'test']),
    kind: z.enum(['impact', 'fall']),
    detectedAt: isoDate.optional(),
    location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().nonnegative().optional() }).optional(),
    metrics: z.record(z.string(), z.number()).optional(),
  }),
  respond: z.object({ response: z.enum(['ok', 'help']) }),
  sensorLog: z.unknown(),
  devOrder: z.object({ storeName: z.string().max(40).optional(), destination: z.string().max(80).optional() }),
};

function bearer(c: Context): string | null {
  const header = c.req.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export function authRoutes(ctx: AppContext) {
  const app = new Hono();

  app.post('/otp', async (c) => {
    const { phone } = await readBody(c, schemas.otp);
    return c.json<OtpResponse>(await requestOtp(ctx, phone));
  });

  app.post('/verify', async (c) => {
    const body = await readBody(c, schemas.verify);
    const { token, rider, isNew } = verifyOtp(ctx, body.phone, body.code, body.consents);
    return c.json<VerifyResponse>({ token, isNew, rider: toRiderDto(rider) }, isNew ? 201 : 200);
  });

  app.post('/logout', (c) => {
    const token = bearer(c);
    if (token) revokeToken(ctx, token);
    return c.body(null, 204);
  });

  return app;
}

export function meRoutes(ctx: AppContext) {
  const app = new Hono<RiderEnv>();

  app.use('*', async (c, next) => {
    const token = bearer(c);
    const riderId = token ? riderIdForToken(ctx, token) : null;
    if (!riderId) throw new ApiError(401, 'unauthorized', '다시 로그인해 주세요.');
    c.set('riderId', riderId);
    await next();
  });

  // 프로필 · 동의
  app.get('/', (c) => c.json<MeDto>(buildMe(ctx, c.var.riderId)));

  app.patch('/', async (c) => {
    const patch = await readBody(c, schemas.updateMe);
    return c.json<RiderDto>(toRiderDto(updateRider(ctx, c.var.riderId, patch)));
  });

  app.put('/consents/:key', async (c) => {
    const key = c.req.param('key');
    if (key !== 'insuranceRecords' && key !== 'medicalInfo') {
      throw new ApiError(400, 'consent_not_optional', '필수 동의는 여기서 철회할 수 없어요. 서비스 탈퇴로 처리해 주세요.');
    }
    const { granted } = await readBody(c, schemas.consent);
    setConsents(ctx, c.var.riderId, { [key]: granted });
    return c.json(consentsOf(ctx, c.var.riderId));
  });

  app.get('/location-access', (c) => c.json<{ items: LocationAccessDto[] }>({ items: listLocationAccess(ctx, c.var.riderId) }));

  // 비상연락망
  app.post('/contacts', async (c) => {
    const input = await readBody(c, schemas.createContact);
    return c.json<ContactDto>(toContactDto(createContact(ctx, c.var.riderId, input)), 201);
  });

  app.patch('/contacts/:id', async (c) => {
    const patch = await readBody(c, schemas.updateContact);
    return c.json<ContactDto>(toContactDto(updateContact(ctx, c.var.riderId, c.req.param('id'), patch)));
  });

  app.delete('/contacts/:id', (c) => {
    deleteContact(ctx, c.var.riderId, c.req.param('id'));
    return c.body(null, 204);
  });

  /** 연락처에게 따로 보내 줄 상시 링크. 볼 수 있는 시점은 연락처의 공개 범위를 따른다. */
  app.post('/contacts/:id/share-link', (c) => {
    const contact = getContact(ctx, c.var.riderId, c.req.param('id'));
    const link = createShareLink(ctx, { riderId: c.var.riderId, contactId: contact.id, incidentId: null });
    return c.json<ShareLinkResponse>({ url: link.url, expiresAt: iso(link.expiresAt) }, 201);
  });

  // 감지 기기
  app.post('/device', async (c) => {
    const { pairingCode } = await readBody(c, schemas.pair);
    return c.json<DeviceDto>(toDeviceDto(ctx, pairDevice(ctx, c.var.riderId, pairingCode)));
  });

  app.delete('/device', (c) => {
    unpairDevice(ctx, c.var.riderId);
    return c.body(null, 204);
  });

  // 운행 세션 · 위치
  app.post('/session', (c) => c.json<SessionDto>(toSessionDto(startSession(ctx, c.var.riderId))));

  app.post('/session/end', (c) => c.json<SessionDto>(toSessionDto(endSession(ctx, c.var.riderId))));

  app.post('/sessions/:id/locations', async (c) => {
    const { points } = await readBody(c, schemas.locations);
    return c.json<UploadLocationsResponse>(addLocations(ctx, c.var.riderId, c.req.param('id'), points));
  });

  // 사고
  app.post('/incidents', async (c) => {
    const body = await readBody(c, schemas.createIncident);
    const device = body.source === 'tag' ? riderDevice(ctx, c.var.riderId) : undefined;
    const { created, incident } = createIncident(ctx, {
      riderId: c.var.riderId,
      source: body.source,
      kind: body.kind,
      detectedAt: body.detectedAt ? Date.parse(body.detectedAt) : undefined,
      location: body.location,
      metrics: body.metrics,
      deviceId: device?.id,
    });
    return c.json<CreateIncidentResponse>({ created, incident: toDetailDto(ctx, incident) }, created ? 201 : 200);
  });

  app.get('/incidents', (c) => c.json<IncidentListResponse>({ items: listIncidentSummaries(ctx, c.var.riderId) }));

  app.get('/incidents/active', (c) => {
    const incident = openIncident(ctx, c.var.riderId);
    return c.json<ActiveIncidentResponse>({ incident: incident ? toDetailDto(ctx, incident) : null });
  });

  app.get('/incidents/:id', (c) => c.json<IncidentDetailDto>(toDetailDto(ctx, riderIncident(ctx, c.var.riderId, c.req.param('id')))));

  app.post('/incidents/:id/respond', async (c) => {
    const { response } = await readBody(c, schemas.respond);
    return c.json<IncidentDetailDto>(toDetailDto(ctx, respond(ctx, c.var.riderId, c.req.param('id'), response)));
  });

  app.put('/incidents/:id/sensor-log', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }), async (c) => {
    const log = await readBody(c, schemas.sensorLog);
    saveSensorLog(ctx, c.var.riderId, c.req.param('id'), log);
    return c.body(null, 204);
  });

  // 개발용: 배달대행사 연동 전까지 '진행 중이던 주문'을 만들어 사고 시 보류·대체배차 흐름을 확인한다.
  if (ctx.config.env !== 'production') {
    app.post('/dev/order', async (c) => {
      const body = await readBody(c, schemas.devOrder);
      const now = ctx.clock.now();
      const order: OrderRow = {
        id: newId('ord'),
        riderId: c.var.riderId,
        storeName: body.storeName ?? '[매장명]',
        destination: body.destination ?? '[배달지]',
        status: 'assigned',
        incidentId: null,
        reassignRequestedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      ctx.db.tx(() => {
        ctx.db.run("UPDATE orders SET status = 'delivered', updatedAt = :now WHERE riderId = :riderId AND status = 'assigned'", { riderId: order.riderId, now });
        ctx.db.run(
          `INSERT INTO orders (id, riderId, storeName, destination, status, incidentId, reassignRequestedAt, createdAt, updatedAt)
           VALUES (:id, :riderId, :storeName, :destination, :status, :incidentId, :reassignRequestedAt, :createdAt, :updatedAt)`,
          order,
        );
      });
      return c.json<OrderDto>({ id: order.id, storeName: order.storeName, destination: order.destination, status: order.status }, 201);
    });
  }

  return app;
}

export const tooLarge = (c: Context) => c.json({ error: { code: 'payload_too_large', message: '요청이 너무 커요.' } }, 413);
