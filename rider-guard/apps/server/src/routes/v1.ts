import type { DetectionV1 } from '@rider-guard/contract';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { AppContext } from '../context.ts';
import { safeEqual } from '../lib.ts';
import { detectionSchema, getDetection, ingestDetection, resetDemo, validationDetails } from '../services/detections.ts';

const MAX_BODY = 64 * 1024;

const fail = (c: Context, status: 400 | 401 | 413 | 422, code: string, message: string, details?: { path: string; message: string }[]) =>
  c.json({ error: { code, message, ...(details ? { details } : null) } }, status);

/**
 * 지표 라우터(또는 재생 스크립트) → 서버. 검사 순서는 연동 명세 4장:
 * 인증(401) → 크기(413) → JSON(400) → 스키마(422) → 라이더(422) → 중복(200/409) → 사고 생성(201) 또는 기록(200).
 * 전송 토큰(INGEST_TOKEN)은 운영 모니터 토큰과 따로다.
 */
export function v1Routes(ctx: AppContext) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const expected = ctx.config.ingestToken;
    if (!expected || !token || !safeEqual(token, expected)) return fail(c, 401, 'unauthorized', '전송 토큰이 올바르지 않아요.');
    await next();
  });
  app.use('*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => fail(c, 413, 'payload_too_large', '본문이 64KB 를 넘어요. 원시 IMU 배열은 넣지 않아요.') }));

  app.post('/detections', async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return fail(c, 400, 'invalid_json', '요청 본문이 올바른 JSON 이 아니에요.');
    }
    const parsed = detectionSchema.safeParse(raw);
    if (!parsed.success) return fail(c, 422, 'validation_failed', '요청이 계약(detection.v1)과 맞지 않아요.', validationDetails(parsed.error));
    const { status, body } = await ingestDetection(ctx, raw, parsed.data as DetectionV1);
    return c.json(body, status);
  });

  app.get('/detections/:id', async (c) => c.json(await getDetection(ctx, c.req.param('id'))));

  app.post('/demo/reset', async (c) => c.json(await resetDemo(ctx)));

  return app;
}
