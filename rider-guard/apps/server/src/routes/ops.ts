import { readFileSync } from 'node:fs';

import type { OpsEmergencyResponse, OpsIncidentDetailDto, OpsIncidentDto, OpsJudgmentDto } from '@rider-guard/contract';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { ApiError, readBody, safeEqual } from '../lib.ts';
import { claimIncident, listForOps, markOrderReassigned, opsDetail, reportEmergency, resolveIncident } from '../services/incidents.ts';
import { listJudgments } from '../services/judgments.ts';

type OpsEnv = { Variables: { operator: string } };

const consoleHtml = readFileSync(new URL('../ops-console.html', import.meta.url), 'utf8');
const resolveSchema = z.object({ outcome: z.enum(['false_alarm', 'handled']), note: z.string().max(500).optional() });

/** 관제센터 상담원용. 에스컬레이션된 사고만 보인다 (4.1.2). */
export function opsRoutes(ctx: AppContext) {
  const app = new Hono<OpsEnv>();

  app.get('/', (c) => c.html(consoleHtml));

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !safeEqual(token, ctx.config.opsToken)) throw new ApiError(401, 'unauthorized', '관제 토큰이 올바르지 않아요.');
    let operator = '';
    try {
      operator = decodeURIComponent(c.req.header('x-operator') ?? '').trim();
    } catch {
      /* 잘못 인코딩된 이름은 빈 값으로 처리 */
    }
    if (!operator) throw new ApiError(400, 'operator_required', '상담원 이름(X-Operator 헤더)이 필요해요.');
    c.set('operator', operator.slice(0, 20));
    await next();
  });

  app.get('/api/judgments', async (c) => c.json<{ items: OpsJudgmentDto[] }>({ items: await listJudgments(ctx) }));

  app.get('/api/incidents', async (c) => c.json<{ items: OpsIncidentDto[] }>({ items: await listForOps(ctx) }));

  app.get('/api/incidents/:id', async (c) => c.json<OpsIncidentDetailDto>(await opsDetail(ctx, c.req.param('id'), c.var.operator)));

  app.post('/api/incidents/:id/claim', async (c) => {
    await claimIncident(ctx, c.req.param('id'), c.var.operator);
    return c.json<OpsIncidentDetailDto>(await opsDetail(ctx, c.req.param('id'), c.var.operator));
  });

  app.post('/api/incidents/:id/emergency', async (c) => c.json<OpsEmergencyResponse>(await reportEmergency(ctx, c.req.param('id'), c.var.operator)));

  app.post('/api/incidents/:id/order-reassigned', async (c) => {
    await markOrderReassigned(ctx, c.req.param('id'), c.var.operator);
    return c.json<OpsIncidentDetailDto>(await opsDetail(ctx, c.req.param('id'), c.var.operator));
  });

  app.post('/api/incidents/:id/resolve', async (c) => {
    const { outcome, note } = await readBody(c, resolveSchema);
    await resolveIncident(ctx, c.req.param('id'), c.var.operator, outcome, note);
    return c.json<OpsIncidentDetailDto>(await opsDetail(ctx, c.req.param('id'), c.var.operator));
  });

  return app;
}
