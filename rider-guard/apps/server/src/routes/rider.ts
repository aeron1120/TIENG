import type {
  AgencyBoardDto,
  CreateAgencyOrderRequest,
  SetAffiliationRequest,
  ActiveIncidentResponse,
  AuthProvidersResponse,
  AuthResponse,
  OAuthStartResponse,
  ContactDto,
  CreateIncidentResponse,
  AdminOverviewDto,
  DeviceDto,
  IncidentDetailDto,
  IncidentListResponse,
  IndicatorReportResponse,
  LocationAccessDto,
  MeDto,
  OrderDto,
  PushTokenRequest,
  RiderDto,
  SessionDto,
  ShareLinkResponse,
  UploadLocationsResponse,
} from '@rider-guard/contract';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import type { AppContext, OrderRow } from '../context.ts';
import { ApiError, escapeHtml, iso, mobileSchema, newId, readBody } from '../lib.ts';
import { deleteAccount } from '../services/account.ts';
import { adminOverview } from '../services/admin.ts';
import { ackIncident, agencyBoard, assignOrder, completeOrder, createAgency, PLATFORMS, reassignOrder, resolveIncident, setAffiliation } from '../services/agency.ts';
import { loginWithEmail, revokeToken, riderIdForToken, signupWithEmail } from '../services/auth.ts';
import { completeOAuth, enabledProviders, exchangeLoginCode, startOAuth } from '../services/oauth.ts';
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
  getRider,
  isOnboarded,
  onboard,
  pairDevice,
  riderDevice,
  setConsents,
  toContactDto,
  toDeviceDto,
  toRiderDto,
  isAdmin,
  phoneSensorBeat,
  setRole,
  unpairDevice,
  updateContact,
  updateRider,
} from '../services/riders.ts';
import { receiveIndicators } from '../services/judgments.ts';
import { removePushToken, savePushToken } from '../services/push.ts';
import { addLocations, endSession, startSession, toSessionDto } from '../services/sessions.ts';
import { createShareLink, listLocationAccess } from '../services/sharing.ts';
import { indicatorReportSchema } from './device.ts';
import { parseJson } from '../db.ts';

export type RiderEnv = { Variables: { riderId: string } };

const relation = z.enum(['family', 'coworker', 'other']);
const shareLevel = z.enum(['realtime', 'on_anomaly', 'on_incident']);
const isoDate = z.iso.datetime({ offset: true });
const name = z.string().trim().min(1, '이름을 입력해 주세요.').max(20);

const schemas = {
  signup: z.object({
    // 복사해 붙여 넣은 앞뒤 공백은 받아 준다
    email: z.string().trim().pipe(z.email('이메일 형식이 아니에요.').max(120)),
    password: z.string().min(8, '비밀번호는 8자 이상이어야 해요.').max(128),
  }),
  login: z.object({ email: z.string().trim().min(1, '이메일을 입력해 주세요.').max(120), password: z.string().min(1, '비밀번호를 입력해 주세요.').max(128) }),
  oauthStart: z.object({ redirectUri: z.string().min(1).max(500) }),
  oauthExchange: z.object({ code: z.string().min(20).max(200), sessionKey: z.string().min(20).max(200) }),
  onboarding: z.object({
    name,
    phone: mobileSchema,
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
  role: z.object({ role: z.enum(['rider', 'dispatcher']) }),
  affiliation: z.object({
    joinCode: z.string().trim().min(4).max(12).nullable().optional(),
    platforms: z.array(z.enum(PLATFORMS as [string, ...string[]])).max(5),
  }),
  createAgency: z.object({ name: z.string().trim().min(1, '대행사 이름을 입력해 주세요.').max(40) }),
  agencyOrder: z.object({
    riderId: z.string().min(1),
    platform: z.enum(PLATFORMS as [string, ...string[]]),
    storeName: z.string().trim().min(1, '가게 이름을 입력해 주세요.').max(40),
    destination: z.string().trim().min(1, '배달지를 입력해 주세요.').max(80),
  }),
  reassign: z.object({ riderId: z.string().min(1) }),
  phoneSensor: z.object({ samples: z.number().int().min(0).max(100_000), sampleRateHz: z.number().positive().max(1000).nullable().optional() }),
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
  pushToken: z.object({ token: z.string().regex(/^Expo(nent)?PushToken\[.+\]$/, 'Expo 푸시 토큰 형식이 아니에요.'), platform: z.enum(['ios', 'android']) }),
  devOrder: z.object({ storeName: z.string().max(40).optional(), destination: z.string().max(80).optional() }),
};

function bearer(c: Context): string | null {
  const header = c.req.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export function authRoutes(ctx: AppContext) {
  const app = new Hono();

  /** 앱이 로그인 버튼을 그릴 때 — 서버에 키가 설정된 SNS 만 보인다 */
  app.get('/providers', (c) => c.json<AuthProvidersResponse>({ email: true, social: enabledProviders(ctx) }));

  // SNS 로그인 — services/oauth.ts 흐름 설명 참고
  app.post('/oauth/:provider/start', async (c) => {
    const { redirectUri } = await readBody(c, schemas.oauthStart);
    return c.json<OAuthStartResponse>(await startOAuth(ctx, c.req.param('provider'), redirectUri));
  });

  app.get('/oauth/:provider/callback', async (c) => {
    const result = await completeOAuth(ctx, c.req.param('provider'), {
      code: c.req.query('code'),
      state: c.req.query('state'),
      error: c.req.query('error'),
    });
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    if (result.kind === 'redirect') return c.redirect(result.location, 302);
    return c.html(
      `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rider Guard</title><body style="font:16px/1.6 system-ui,sans-serif;padding:32px 20px;background:#F4F1EA;color:#16181D"><h1 style="font-size:20px">Rider Guard</h1><p>${escapeHtml(result.message)}</p></body></html>`,
      result.status,
    );
  });

  app.post('/oauth/exchange', async (c) => {
    const { code, sessionKey } = await readBody(c, schemas.oauthExchange);
    return c.json<AuthResponse>(await exchangeLoginCode(ctx, code, sessionKey));
  });

  app.post('/signup', async (c) => {
    const { email, password } = await readBody(c, schemas.signup);
    const { token } = await signupWithEmail(ctx, email, password);
    return c.json<AuthResponse>({ token, isNew: true, onboarded: false }, 201);
  });

  app.post('/login', async (c) => {
    const { email, password } = await readBody(c, schemas.login);
    const { rider, token } = await loginWithEmail(ctx, email, password);
    return c.json<AuthResponse>({ token, isNew: false, onboarded: await isOnboarded(ctx, rider) });
  });

  app.post('/logout', async (c) => {
    const token = bearer(c);
    if (token) await revokeToken(ctx, token);
    return c.body(null, 204);
  });

  return app;
}

export function meRoutes(ctx: AppContext) {
  const app = new Hono<RiderEnv>();

  app.use('*', async (c, next) => {
    const token = bearer(c);
    const riderId = token ? await riderIdForToken(ctx, token) : null;
    if (!riderId) throw new ApiError(401, 'unauthorized', '다시 로그인해 주세요.');
    c.set('riderId', riderId);
    await next();
  });

  // 프로필 · 동의
  app.get('/', async (c) => c.json<MeDto>(await buildMe(ctx, c.var.riderId)));

  // 첫 로그인 때 배달기사·관제사 중 고른다 (시작하기 전에만 다시 고를 수 있다 — services/riders.ts canChangeRole). 관리자는 ADMIN_EMAILS 로 정해져 여기서 고를 수 없다
  app.put('/role', async (c) => {
    const { role } = await readBody(c, schemas.role);
    await setRole(ctx, c.var.riderId, role);
    return c.json<MeDto>(await buildMe(ctx, c.var.riderId));
  });

  // 배달대행사 소속 — 라이더는 가입 코드와 일하는 플랫폼, 관제사는 가입 코드로 다른 관제사의 대행사에 합류
  app.put('/affiliation', async (c) => {
    const body = await readBody(c, schemas.affiliation);
    await setAffiliation(ctx, c.var.riderId, body as SetAffiliationRequest);
    return c.json<MeDto>(await buildMe(ctx, c.var.riderId));
  });

  // 관제사: 대행사 등록 · 관제 화면 · 주문 배정 · 사고 접수/완료 · 대체 배차
  app.post('/agency', async (c) => {
    const { name } = await readBody(c, schemas.createAgency);
    await createAgency(ctx, c.var.riderId, name);
    return c.json<AgencyBoardDto>(await agencyBoard(ctx, c.var.riderId), 201);
  });
  app.get('/agency', async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json<AgencyBoardDto>(await agencyBoard(ctx, c.var.riderId));
  });
  app.post('/agency/orders', async (c) => {
    const body = await readBody(c, schemas.agencyOrder);
    await assignOrder(ctx, c.var.riderId, body as CreateAgencyOrderRequest);
    return c.json<AgencyBoardDto>(await agencyBoard(ctx, c.var.riderId), 201);
  });
  app.post('/agency/orders/:id/delivered', async (c) => {
    await completeOrder(ctx, c.var.riderId, c.req.param('id'));
    return c.json<AgencyBoardDto>(await agencyBoard(ctx, c.var.riderId));
  });
  app.post('/agency/orders/:id/reassign', async (c) => {
    const { riderId } = await readBody(c, schemas.reassign);
    await reassignOrder(ctx, c.var.riderId, c.req.param('id'), riderId);
    return c.json<AgencyBoardDto>(await agencyBoard(ctx, c.var.riderId));
  });
  app.post('/agency/incidents/:id/ack', async (c) => {
    await ackIncident(ctx, c.var.riderId, c.req.param('id'));
    return c.json<AgencyBoardDto>(await agencyBoard(ctx, c.var.riderId));
  });
  app.post('/agency/incidents/:id/resolve', async (c) => {
    await resolveIncident(ctx, c.var.riderId, c.req.param('id'));
    return c.json<AgencyBoardDto>(await agencyBoard(ctx, c.var.riderId));
  });

  // 관리자 운영 현황 — 실제 사고·판정 기록 (읽기 전용)
  app.get('/admin/overview', async (c) => {
    if (!(await isAdmin(ctx, c.var.riderId))) throw new ApiError(403, 'admin_only', '관리자만 볼 수 있어요.');
    c.header('Cache-Control', 'no-store');
    return c.json<AdminOverviewDto>(await adminOverview(ctx));
  });

  /** 가입 정보(이름·휴대폰·동의). 가입 직후 한 번, 이후 수정할 때도 쓴다. */
  app.post('/onboarding', async (c) => {
    const input = await readBody(c, schemas.onboarding);
    await onboard(ctx, c.var.riderId, input);
    return c.json<MeDto>(await buildMe(ctx, c.var.riderId));
  });

  /** 회원 탈퇴 (앱 안에서 탈퇴할 수 있어야 한다 — Google Play 정책) */
  app.delete('/', async (c) => {
    await deleteAccount(ctx, c.var.riderId);
    return c.body(null, 204);
  });

  app.patch('/', async (c) => {
    const patch = await readBody(c, schemas.updateMe);
    return c.json<RiderDto>(toRiderDto(await updateRider(ctx, c.var.riderId, patch)));
  });

  app.put('/consents/:key', async (c) => {
    const key = c.req.param('key');
    if (key !== 'insuranceRecords' && key !== 'medicalInfo') {
      throw new ApiError(400, 'consent_not_optional', '필수 동의는 여기서 철회할 수 없어요. 서비스 탈퇴로 처리해 주세요.');
    }
    const { granted } = await readBody(c, schemas.consent);
    await setConsents(ctx, c.var.riderId, { [key]: granted });
    return c.json(await consentsOf(ctx, c.var.riderId));
  });

  /** 앱이 로그인할 때마다 등록한다. 토큰이 바뀌거나 다른 라이더가 같은 폰으로 로그인하면 덮어쓴다. */
  app.put('/push-token', async (c) => {
    const { token, platform }: PushTokenRequest = await readBody(c, schemas.pushToken);
    await savePushToken(ctx, c.var.riderId, token, platform);
    return c.body(null, 204);
  });

  app.delete('/push-token/:token', async (c) => {
    await removePushToken(ctx, c.var.riderId, c.req.param('token'));
    return c.body(null, 204);
  });

  app.get('/location-access', async (c) => c.json<{ items: LocationAccessDto[] }>({ items: await listLocationAccess(ctx, c.var.riderId) }));

  // 비상연락망
  app.post('/contacts', async (c) => {
    const input = await readBody(c, schemas.createContact);
    return c.json<ContactDto>(toContactDto(await createContact(ctx, c.var.riderId, input)), 201);
  });

  app.patch('/contacts/:id', async (c) => {
    const patch = await readBody(c, schemas.updateContact);
    return c.json<ContactDto>(toContactDto(await updateContact(ctx, c.var.riderId, c.req.param('id'), patch)));
  });

  app.delete('/contacts/:id', async (c) => {
    await deleteContact(ctx, c.var.riderId, c.req.param('id'));
    return c.body(null, 204);
  });

  /** 연락처에게 따로 보내 줄 상시 링크. 볼 수 있는 시점은 연락처의 공개 범위를 따른다. */
  app.post('/contacts/:id/share-link', async (c) => {
    const contact = await getContact(ctx, c.var.riderId, c.req.param('id'));
    const link = await createShareLink(ctx, { riderId: c.var.riderId, contactId: contact.id, incidentId: null });
    return c.json<ShareLinkResponse>({ url: link.url, expiresAt: iso(link.expiresAt) }, 201);
  });

  // 감지 기기
  app.post('/device', async (c) => {
    const { pairingCode } = await readBody(c, schemas.pair);
    return c.json<DeviceDto>(toDeviceDto(ctx, await pairDevice(ctx, c.var.riderId, pairingCode)));
  });

  // 헬멧 기기 없이 휴대폰 자체 가속도계·자이로를 감지 센서로 — 15초마다 상태 보고, 충격 후보 구간은 /me/indicators 로
  app.put('/phone-sensor', async (c) => {
    const body = await readBody(c, schemas.phoneSensor);
    return c.json<DeviceDto>(toDeviceDto(ctx, await phoneSensorBeat(ctx, c.var.riderId, body)));
  });

  app.delete('/device', async (c) => {
    await unpairDevice(ctx, c.var.riderId);
    return c.body(null, 204);
  });

  // 운행 세션 · 위치
  app.post('/session', async (c) => {
    // 위치 수집 동의 없이 수집을 시작하지 않는다 (9.1)
    if (!(await isOnboarded(ctx, await getRider(ctx, c.var.riderId)))) {
      throw new ApiError(403, 'onboarding_required', '가입 정보와 필수 동의를 마쳐야 운행을 시작할 수 있어요.');
    }
    return c.json<SessionDto>(toSessionDto(await startSession(ctx, c.var.riderId)));
  });

  app.post('/session/end', async (c) => c.json<SessionDto>(toSessionDto(await endSession(ctx, c.var.riderId))));

  app.post('/sessions/:id/locations', async (c) => {
    const { points } = await readBody(c, schemas.locations);
    return c.json<UploadLocationsResponse>(await addLocations(ctx, c.var.riderId, c.req.param('id'), points));
  });

  // 사고
  app.post('/incidents', async (c) => {
    const body = await readBody(c, schemas.createIncident);
    const device = body.source === 'tag' ? await riderDevice(ctx, c.var.riderId) : undefined;
    const { created, incident } = await createIncident(ctx, {
      riderId: c.var.riderId,
      source: body.source,
      kind: body.kind,
      detectedAt: body.detectedAt ? Date.parse(body.detectedAt) : undefined,
      location: body.location,
      metrics: body.metrics,
      deviceId: device?.id,
    });
    return c.json<CreateIncidentResponse>({ created, incident: await toDetailDto(ctx, incident) }, created ? 201 : 200);
  });

  /** 태그 → BLE → 휴대폰 → 서버 경로 (설계문서 3.1). 판정은 기기 직접 보고와 같다. */
  app.post('/indicators', async (c) => {
    const report = await readBody(c, indicatorReportSchema);
    const device = await riderDevice(ctx, c.var.riderId);
    return c.json<IndicatorReportResponse>(await receiveIndicators(ctx, { riderId: c.var.riderId, deviceId: device?.id ?? null, via: 'phone', phoneImu: device?.kind === 'phone' }, report));
  });

  app.get('/incidents', async (c) => c.json<IncidentListResponse>({ items: await listIncidentSummaries(ctx, c.var.riderId) }));

  app.get('/incidents/active', async (c) => {
    const incident = await openIncident(ctx, c.var.riderId);
    return c.json<ActiveIncidentResponse>({ incident: incident ? await toDetailDto(ctx, incident) : null });
  });

  app.get('/incidents/:id', async (c) => c.json<IncidentDetailDto>(await toDetailDto(ctx, await riderIncident(ctx, c.var.riderId, c.req.param('id')))));

  app.get('/incidents/:id/export', async (c) => {
    const incident = await riderIncident(ctx, c.var.riderId, c.req.param('id'));
    const consents = await consentsOf(ctx, c.var.riderId);
    if (!consents.insuranceRecords) throw new ApiError(403, 'export_consent_required', '기록 파일 제공 동의를 먼저 확인해 주세요.');
    c.header('Cache-Control', 'no-store');
    c.header('Content-Disposition', `attachment; filename="rider-guard-${incident.id}.json"`);
    return c.json({ schemaVersion: 'incident-export-v1', exportedAt: iso(ctx.clock.now()), incident: await toDetailDto(ctx, incident), sensorLog: parseJson<unknown>(incident.sensorLogJson), consents, notice: '저장된 기록입니다. 실제 사고·상해 정도 또는 외부 기관의 인정을 확인하는 자료가 아닙니다.' });
  });

  app.post('/incidents/:id/respond', async (c) => {
    const { response } = await readBody(c, schemas.respond);
    return c.json<IncidentDetailDto>(await toDetailDto(ctx, await respond(ctx, c.var.riderId, c.req.param('id'), response)));
  });

  app.put('/incidents/:id/sensor-log', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }), async (c) => {
    const log = await readBody(c, schemas.sensorLog);
    await saveSensorLog(ctx, c.var.riderId, c.req.param('id'), log);
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
      await ctx.db.tx(async () => {
        await ctx.db.run("UPDATE orders SET status = 'delivered', updatedAt = :now WHERE riderId = :riderId AND status = 'assigned'", { riderId: order.riderId, now });
        await ctx.db.run(
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
