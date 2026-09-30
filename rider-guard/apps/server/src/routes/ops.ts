import { readFileSync } from 'node:fs';

import type { OpsDetectionDto, OpsIncidentDetailDto, OpsIncidentDto, OpsJudgmentDto } from '@rider-guard/contract';
import { Hono } from 'hono';

import { DEV_OPS_TOKEN } from '../config.ts';
import type { AppContext } from '../context.ts';
import { ApiError, safeEqual } from '../lib.ts';
import { recentDetections } from '../services/detections.ts';
import { listForOps, opsDetail } from '../services/incidents.ts';
import { listJudgments } from '../services/judgments.ts';

const consoleHtml = readFileSync(new URL('../ops-console.html', import.meta.url), 'utf8');

/**
 * 운영 모니터 (읽기 전용). 사고 대응은 관제 상담원 없이 서버가 전부 처리하므로 누를 버튼이 없다 —
 * 자동 대응이 제대로 돌았는지와 판정 근거만 본다. 에스컬레이션된 사고만 보인다 (4.1.2).
 */
export function opsRoutes(ctx: AppContext) {
  const app = new Hono();

  // 개발용 기본 토큰은 서버가 그 토큰으로 떴을 때만 미리 채운다 — 운영 모니터에 엉뚱한 값이 들어가지 않게
  const page = ctx.config.opsToken === DEV_OPS_TOKEN
    ? consoleHtml.replace("/*DEFAULT_TOKEN*/''", JSON.stringify(DEV_OPS_TOKEN))
    : consoleHtml;
  app.get('/', (c) => c.html(page));

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !safeEqual(token, ctx.config.opsToken)) throw new ApiError(401, 'unauthorized', '모니터 토큰이 올바르지 않아요.');
    await next();
  });

  app.get('/api/judgments', async (c) => c.json<{ items: OpsJudgmentDto[] }>({ items: await listJudgments(ctx) }));

  app.get('/api/detections', async (c) => c.json<{ items: OpsDetectionDto[] }>({ items: await recentDetections(ctx) }));

  app.get('/api/incidents', async (c) => c.json<{ items: OpsIncidentDto[] }>({ items: await listForOps(ctx) }));

  app.get('/api/incidents/:id', async (c) => c.json<OpsIncidentDetailDto>(await opsDetail(ctx, c.req.param('id'))));

  return app;
}
