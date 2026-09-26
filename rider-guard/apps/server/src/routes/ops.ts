import { readFileSync } from 'node:fs';

import type { OpsEmergencyResponse, OpsIncidentDetailDto, OpsIncidentDto } from '@rider-guard/contract';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { ApiError, readBody, safeEqual } from '../lib.ts';
import { claimIncident, listForOps, markOrderReassigned, opsDetail, reportEmergency, resolveIncident } from '../services/incidents.ts';

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

  app.get('/api/incidents', (c) => c.json<{ items: OpsIncidentDto[] }>({ items: listForOps(ctx) }));

  app.get('/api/incidents/:id', (c) => c.json<OpsIncidentDetailDto>(opsDetail(ctx, c.req.param('id'), c.var.operator)));

  app.post('/api/incidents/:id/claim', (c) => {
    claimIncident(ctx, c.req.param('id'), c.var.operator);
    return c.json<OpsIncidentDetailDto>(opsDetail(ctx, c.req.param('id'), c.var.operator));
  });

  app.post('/api/incidents/:id/emergency', async (c) => c.json<OpsEmergencyResponse>(await reportEmergency(ctx, c.req.param('id'), c.var.operator)));

  app.post('/api/incidents/:id/order-reassigned', (c) => {
    markOrderReassigned(ctx, c.req.param('id'), c.var.operator);
    return c.json<OpsIncidentDetailDto>(opsDetail(ctx, c.req.param('id'), c.var.operator));
  });

  app.post('/api/incidents/:id/resolve', async (c) => {
    const { outcome, note } = await readBody(c, resolveSchema);
    resolveIncident(ctx, c.req.param('id'), c.var.operator, outcome, note);
    return c.json<OpsIncidentDetailDto>(opsDetail(ctx, c.req.param('id'), c.var.operator));
  });

  return app;
}
