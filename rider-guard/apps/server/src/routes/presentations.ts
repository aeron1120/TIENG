import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { detectionSchema, validationDetails } from '../services/detections.ts';
import { commandPresentation, createPresentation, readPresentation } from '../services/presentations.ts';

const scenario = z.enum(['full', 'normal', 'curb', 'stopped', 'gap']);
const wallTime = z.number().int().min(0).max(8640000000000000 - 86400000);
const createSchema = z.strictObject({
  scenario: scenario.optional(), caseId: z.string().min(1).max(64).optional(),
  detection: detectionSchema.optional(), origin: z.literal('integrated').optional(), baseWall: wallTime.optional(),
}).superRefine((input, ctx) => {
  if (input.detection && (input.caseId || input.origin || input.scenario)) ctx.addIssue({ code: 'custom', message: '외부 자료와 실측 시나리오는 한 세션에 섞을 수 없어요.' });
  if (input.origin && input.caseId) ctx.addIssue({ code: 'custom', message: '통합 시연은 시나리오로 조건을 고르세요.' });
  if (input.detection && input.detection.source.mode !== 'replay') ctx.addIssue({ code: 'custom', path: ['detection', 'source', 'mode'], message: '발표에서는 replay 자료만 사용할 수 있어요.' });
  // Preserve the source values while rejecting time ranges the demo cannot represent safely.
  if (input.detection) {
    for (const [path, value] of [
      [['result', 't_candidate_s'], input.detection.result.t_candidate_s],
      [['source', 'replay', 'event_onset_s'], input.detection.source.replay?.event_onset_s],
    ] as const) {
      if (value != null && Math.abs(value) > 1e9) ctx.addIssue({ code: 'custom', path: ['detection', ...path], message: '센서 시각 범위가 너무 커요.' });
    }
  }
});
const previewSchema = createSchema.refine((input) => !!input.detection, { path: ['detection'], message: '미리 볼 detection.v1 자료가 필요해요.' });
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

async function body<S extends z.ZodType>(c: Context, schema: S, respond: (input: z.infer<S>) => Response | Promise<Response>): Promise<Response> {
  let input: unknown;
  try { input = await c.req.json(); } catch { return c.json({ error: { code: 'invalid_json', message: '올바른 JSON 본문이 필요해요.', details: [{ path: '$', message: 'JSON 문법을 확인하세요.' }] } }, 400); }
  const result = schema.safeParse(input);
  if (!result.success) return c.json({ error: { code: 'invalid_presentation', message: result.error.issues[0]?.message ?? '발표 요청 형식이 올바르지 않아요.', details: validationDetails(result.error) } }, 422);
  return respond(result.data);
}
const tokenOf = (c: Context) => c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];

export function presentationRoutes(ctx: AppContext) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  app.post('/preview', (c) => body(c, previewSchema, (input) => c.json({ detection: input.detection })));
  app.post('/', (c) => body(c, createSchema, async (input) => c.json(await createPresentation(ctx, input), 201)));
  app.get('/:id', async (c) => c.json(await readPresentation(ctx, c.req.param('id'), tokenOf(c))));
  app.post('/:id/commands', (c) => body(c, commandsSchema, async (input) => c.json(await commandPresentation(ctx, c.req.param('id'), tokenOf(c), input.commands))));
  return app;
}
