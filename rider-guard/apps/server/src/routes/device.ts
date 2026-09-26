import type { DeviceEventResponse, DeviceHeartbeatResponse, RegisterDeviceResponse } from '@rider-guard/contract';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppContext, DeviceRow } from '../context.ts';
import { ApiError, newId, newToken, readBody, sha256, sixDigits } from '../lib.ts';
import { createIncident } from '../services/incidents.ts';
import { activeSession } from '../services/sessions.ts';

type DeviceEnv = { Variables: { device: DeviceRow } };

const schemas = {
  register: z.object({ name: z.string().trim().min(1).max(40), kind: z.enum(['tag', 'webcam']) }),
  heartbeat: z.object({ battery: z.number().int().min(0).max(100).optional() }),
  event: z.object({
    kind: z.enum(['impact', 'fall']),
    detectedAt: z.iso.datetime({ offset: true }).optional(),
    metrics: z.record(z.string(), z.number()).optional(),
  }),
};

/**
 * 감지 기기 API. 신체 착용 태그는 BLE 로 휴대폰을 거쳐 /me/incidents 로 올리고,
 * 네트워크에 직접 붙는 기기(테스트용 웹캠 detector 등)는 여기로 직접 보낸다.
 */
export function deviceRoutes(ctx: AppContext) {
  const app = new Hono<DeviceEnv>();

  app.post('/register', async (c) => {
    const { name, kind } = await readBody(c, schemas.register);
    const deviceToken = newToken();
    const device: DeviceRow = {
      id: newId('dev'),
      tokenHash: sha256(deviceToken),
      kind,
      name,
      pairingCode: uniquePairingCode(ctx),
      riderId: null,
      battery: null,
      lastSeenAt: ctx.clock.now(),
      createdAt: ctx.clock.now(),
      pairedAt: null,
    };
    ctx.db.run(
      `INSERT INTO devices (id, tokenHash, kind, name, pairingCode, riderId, battery, lastSeenAt, createdAt, pairedAt)
       VALUES (:id, :tokenHash, :kind, :name, :pairingCode, :riderId, :battery, :lastSeenAt, :createdAt, :pairedAt)`,
      device,
    );
    return c.json<RegisterDeviceResponse>({ deviceId: device.id, deviceToken, pairingCode: device.pairingCode }, 201);
  });

  app.use('*', async (c, next) => {
    if (c.req.path.endsWith('/register')) return next();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Device ') ? header.slice(7).trim() : '';
    const device = token ? ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE tokenHash = :tokenHash', { tokenHash: sha256(token) }) : undefined;
    if (!device) throw new ApiError(401, 'unauthorized', '등록되지 않은 기기예요.');
    c.set('device', device);
    await next();
  });

  app.post('/heartbeat', async (c) => {
    const { battery } = await readBody(c, schemas.heartbeat);
    const device = c.var.device;
    ctx.db.run('UPDATE devices SET lastSeenAt = :now, battery = COALESCE(:battery, battery) WHERE id = :id', {
      id: device.id,
      now: ctx.clock.now(),
      battery,
    });
    return c.json<DeviceHeartbeatResponse>({ paired: !!device.riderId, sessionActive: !!device.riderId && !!activeSession(ctx, device.riderId) });
  });

  app.post('/events', async (c) => {
    const body = await readBody(c, schemas.event);
    const device = c.var.device;
    ctx.db.run('UPDATE devices SET lastSeenAt = :now WHERE id = :id', { id: device.id, now: ctx.clock.now() });
    if (!device.riderId) return c.json<DeviceEventResponse>({ status: 'ignored', reason: 'not_paired' });
    // 운행 중이 아니면 감지하지 않는다 (9.4) — 오류가 아니라 정상적인 무시.
    if (!activeSession(ctx, device.riderId)) return c.json<DeviceEventResponse>({ status: 'ignored', reason: 'no_active_session' });
    const { created, incident } = createIncident(ctx, {
      riderId: device.riderId,
      source: 'device',
      kind: body.kind,
      detectedAt: body.detectedAt ? Date.parse(body.detectedAt) : undefined,
      metrics: body.metrics,
      deviceId: device.id,
    });
    return c.json<DeviceEventResponse>({ status: created ? 'created' : 'duplicate', incidentId: incident.id }, created ? 201 : 200);
  });

  return app;
}

function uniquePairingCode(ctx: AppContext): string {
  for (;;) {
    const code = sixDigits();
    if (!ctx.db.get('SELECT 1 FROM devices WHERE pairingCode = :code', { code })) return code;
  }
}
