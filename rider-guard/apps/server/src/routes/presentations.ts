import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { ApiError } from '../lib.ts';
import { detectionSchema } from '../services/detections.ts';
import { commandPresentation, createPresentation, readPresentation } from '../services/presentations.ts';

const scenario = z.enum(['full', 'normal', 'curb', 'stopped', 'gap']);
const wallTime = z.number().int().min(0).max(8640000000000000 - 86400000);
const createSchema = z.strictObject({
  scenario: scenario.optional(), caseId: z.string().min(1).max(64).optional(),
  detection: detectionSchema.optional(), origin: z.literal('integrated').optional(), baseWall: wallTime.optional(),
}).superRefine((input, ctx) => {
  if (input.detection && (input.caseId || input.origin || input.scenario)) ctx.addIssue({ code: 'custom', message: '외부 자료와 실측 시나리오는 한 세션에 섞을 수 없어요.' });
  if (input.origin && input.caseId) ctx.addIssue({ code: 'custom', message: '통합 시연은 시나리오로 조건을 고르세요.' });
  if (input.detection && input.detection.source.mode !== 'replay') ctx.addIssue({ code: 'custom', message: '발표에서는 replay 자료만 사용할 수 있어요.' });
  // Preserve the source values while rejecting time ranges the demo cannot represent safely.
  if (input.detection && [input.detection.result.t_candidate_s, input.detection.source.replay?.event_onset_s].some((v) => v != null && Math.abs(v) > 1e9)) ctx.addIssue({ code: 'custom', message: '센서 시각 범위가 너무 커요.' });
});
const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('play'), driver: z.string().min(1).max(128) }),
  z.strictObject({ type: z.literal('pause') }),
  z.strictObject({ type: z.literal('reset'), scenario: scenario.optional(), baseWall: wallTime }),
  z.strictObject({ type: z.literal('tick'), dt: z.number().positive().max(0.5) }),
  z.strictObject({ type: z.literal('slowmo'), on: z.boolean() }),
  z.strictObject({ type: z.literal('autopilot'), on: z.boolean() }),
  z.strictObject({ type: z.literal('sensor'), lost: z.boolean() }),
  z.strictObject({ type: z.literal('respond'), response: z.enum(['ok', 'help']) }),
  z.strictObject({ type: z.literal('skipWait') }),
  z.strictObject({ type: z.literal('ack') }),
  z.strictObject({ type: z.literal('call') }),
  z.strictObject({ type: z.literal('reassign'), orderId: z.string().min(1).max(64), riderId: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal('resolve') }),
]);
const commandsSchema = z.strictObject({ commands: z.array(z.strictObject({ seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), action: actionSchema })).min(1).max(100) });

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let input: unknown;
  try { input = await c.req.json(); } catch { throw new ApiError(400, 'invalid_json', '올바른 JSON 본문이 필요해요.'); }
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(422, 'invalid_presentation', result.error.issues[0]?.message ?? '발표 요청 형식이 올바르지 않아요.');
  return result.data;
}
const tokenOf = (c: Context) => c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];

export function presentationRoutes(ctx: AppContext) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  app.post('/', async (c) => c.json(await createPresentation(ctx, await body(c, createSchema)), 201));
  app.get('/:id', async (c) => c.json(await readPresentation(ctx, c.req.param('id'), tokenOf(c))));
  app.post('/:id/commands', async (c) => {
    const input = await body(c, commandsSchema);
    return c.json(await commandPresentation(ctx, c.req.param('id'), tokenOf(c), input.commands));
  });
  return app;
}
