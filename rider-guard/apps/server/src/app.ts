import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { AppContext } from './context.ts';
import { ApiError } from './lib.ts';
import { deviceRoutes } from './routes/device.ts';
import { opsRoutes } from './routes/ops.ts';
import { authRoutes, meRoutes, tooLarge } from './routes/rider.ts';
import { shareRoutes } from './routes/share.ts';
import { v1Routes } from './routes/v1.ts';
import { SCHEMA_VERSION } from './services/detections.ts';

export function createApp(ctx: AppContext) {
  const app = new Hono();

  // 라이더 앱(웹 포함)은 토큰을 헤더로 보내고 쿠키를 쓰지 않으므로 출처 제한 없이 연다.
  for (const path of ['/auth/*', '/me', '/me/*']) app.use(path, cors());
  // 센서 로그 업로드만 1MB(라우트에서 제한), 나머지는 64KB. /v1 은 인증을 먼저 보고 나서 크기를 잰다(라우트에서)
  const defaultLimit = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
  app.use('*', (c, next) => (c.req.path.endsWith('/sensor-log') || c.req.path.startsWith('/v1/') ? next() : defaultLimit(c, next)));

  app.get('/health', (c) => c.json({ ok: true }));
  // 발표 전에 서버를 깨우는 용도 — 인증 없음
  app.get('/healthz', (c) => c.json({ ok: true, schema_version: SCHEMA_VERSION, demo_mode: ctx.config.demoMode }));
  app.route('/v1', v1Routes(ctx));
  app.route('/auth', authRoutes(ctx));
  app.route('/me', meRoutes(ctx));
  app.route('/device-api', deviceRoutes(ctx));
  app.route('/s', shareRoutes(ctx));
  app.route('/ops', opsRoutes(ctx));

  app.notFound((c) => c.json({ error: { code: 'not_found', message: '없는 경로예요.' } }, 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof HTTPException) return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    ctx.log.error(`${c.req.method} ${c.req.path}`, err);
    return c.json({ error: { code: 'internal', message: '서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' } }, 500);
  });
  return app;
}
