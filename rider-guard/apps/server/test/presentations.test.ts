import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DetectionV1 } from '@rider-guard/contract';
import type { CreatedPresentation, PresentationCommand, PresentationSession } from '../../../packages/demo/presentation.ts';
import { createApp } from '../src/app.ts';
import { Db } from '../src/db.ts';
import { setup } from './helpers.ts';

const endpoint = '/demo-api/presentations';
const imported = (candidate = true): DetectionV1 => ({
  schema_version: '1.0', detection_id: 'import-example-0001', rider_id: 'external-rider', occurred_at: '2026-10-01T00:00:00Z',
  source: { mode: 'replay', device: 'helmet_tag', mount: 'helmet', replay: { run_id: 'run-1', scenario_id: 'external-case', scenario_name: '외부 검증 자료', ground_truth: 'unknown' } },
  detector: { name: 'external', version: '1', status: 'replay', profile: 'custom', rule: { expression: 'external rule', window_s: 0.5, warmup_s: 0 } },
  result: { candidate, t_candidate_s: candidate ? 150.25 : null },
  evidence: [{ key: 'impact', label: '외부 충격', group: 'required', value: 7, threshold: 5, op: '>=', unit: 'g', decimals: 1, fired: true, value_basis: 'window' }],
});

test('replay preview validates the same strict import without creating a session', async () => {
  const t = await setup();
  try {
    const preview = await t.call<{ detection: DetectionV1 }>('POST', `${endpoint}/preview`, { body: { detection: imported() } });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.deepEqual(preview.json, { detection: imported() });
    assert.equal((await t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM presentationSessions'))?.n, 0);
    for (const path of [endpoint, `${endpoint}/preview`]) {
      const invalid = await t.call<{ error: { details: { path: string; message: string }[] } }>('POST', path, { body: { detection: { ...imported(), result: { candidate: true, t_candidate_s: null }, '<img>': true } } });
      assert.equal(invalid.status, 422);
      assert.ok(invalid.json.error.details.some((detail) => detail.path === '$.detection.result.t_candidate_s'));
      assert.ok(invalid.json.error.details.some((detail) => detail.path === '$.detection.<img>'));
    }
    for (const body of [{}, { detection: { ...imported(), source: { ...imported().source, mode: 'live' } } }, { detection: { ...imported(), result: { candidate: true, t_candidate_s: 1e10 } } }]) {
      assert.equal((await t.call('POST', `${endpoint}/preview`, { body })).status, 422);
    }
    const app = createApp(t.ctx);
    assert.equal((await app.request(`${endpoint}/preview`, { method: 'POST', body: '{' })).status, 400);
    assert.equal((await app.request(`${endpoint}/preview`, { method: 'POST', body: 'x'.repeat(66000) })).status, 413);
    assert.equal((await t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM presentationSessions'))?.n, 0);
  } finally { t.ctx.db.close(); }
});

test('presentation capabilities are isolated, hashed, non-cacheable, and never returned on reads', async () => {
  const t = await setup();
  const c = await t.call<CreatedPresentation>('POST', endpoint, { body: { origin: 'integrated' } });
  assert.equal(c.status, 201);
  assert.equal(c.headers.get('cache-control'), 'no-store');
  assert.notEqual(c.json.readToken, c.json.writeToken);
  const path = `${endpoint}/${c.json.id}`;
  for (const token of [undefined, 'wrong', t.ctx.config.opsToken]) assert.equal((await t.call('GET', path, { token })).status, 401);
  const view = await t.call<PresentationSession>('GET', path, { token: c.json.readToken });
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('cache-control'), 'no-store');
  assert.ok(!view.text.includes(c.json.readToken) && !view.text.includes(c.json.writeToken));
  assert.equal((await t.call('POST', `${path}/commands`, { token: c.json.readToken, body: { commands: [{ seq: 1, action: { type: 'pause' } }] } })).status, 401);
  const other = await t.call<CreatedPresentation>('POST', endpoint, { body: {} });
  assert.equal((await t.call('GET', `${endpoint}/${other.json.id}`, { token: c.json.writeToken })).status, 401);
  const row = JSON.stringify(await t.ctx.db.get('SELECT * FROM presentationSessions WHERE id = :id', { id: c.json.id }));
  assert.ok(!row.includes(c.json.readToken) && !row.includes(c.json.writeToken));
  t.ctx.db.close();
});

test('ordered commands persist, exact retries are idempotent, gaps and changed retries roll back', async () => {
  const t = await setup();
  const { json: c } = await t.call<CreatedPresentation>('POST', endpoint, { body: { scenario: 'full', origin: 'integrated', baseWall: 1700000000000 } });
  const send = (commands: unknown[]) => t.call<PresentationSession>('POST', `${endpoint}/${c.id}/commands`, { token: c.writeToken, body: { commands } });
  const batch = [{ seq: 1, action: { type: 'play', driver: 'test' } }, { seq: 2, action: { type: 'tick', dt: 0.5 } }];
  const first = await send(batch);
  assert.equal(first.status, 200);
  assert.equal(first.json.state.t, 0.5);
  assert.deepEqual((await send(batch)).json, first.json);
  assert.equal((await send([{ seq: 2, action: { type: 'pause' } }])).status, 409);
  assert.equal((await send([{ seq: 3, action: { type: 'tick', dt: 0.5 } }, { seq: 5, action: { type: 'pause' } }])).status, 409);
  const recreated = createApp(t.ctx);
  const view = await recreated.request(`${endpoint}/${c.id}`, { headers: { authorization: `Bearer ${c.readToken}` } });
  assert.deepEqual(await view.json(), first.json);
  const reset = await send([{ seq: 3, action: { type: 'reset', scenario: 'curb', baseWall: 1700000001000 } }]);
  assert.equal(reset.json.source.caseId, 'D6');
  assert.equal(reset.json.clip.candidateAt, null);
  assert.deepEqual((await send([{ seq: 3, action: { type: 'reset', scenario: 'curb', baseWall: 1700000001000 } }])).json, reset.json);
  assert.equal((await send([{ seq: 3, action: { type: 'reset', scenario: 'full', baseWall: 1700000001000 } }])).status, 409);
  assert.equal((await send([{ seq: 4, action: { type: 'reset', scenario: 'full', baseWall: 1700000001000 } }, { seq: 6, action: { type: 'pause' } }])).status, 409);
  assert.deepEqual((await t.call<PresentationSession>('GET', `${endpoint}/${c.id}`, { token: c.readToken })).json, reset.json);
  t.ctx.db.close();
});

test('strict request bounds, replay imports, expiry, and standalone source retention', async () => {
  const t = await setup();
  for (const body of [{ caseId: 'unknown' }, { origin: 'integrated', caseId: 'A2' }, { caseId: 'A1', detection: imported() }, { extra: true }, { detection: { ...imported(), source: { ...imported().source, mode: 'live' } } }]) {
    assert.equal((await t.call('POST', endpoint, { body })).status, 422);
  }
  const { json: c } = await t.call<CreatedPresentation>('POST', endpoint, { body: { caseId: 'A2' } });
  const send = (commands: unknown[]) => t.call<PresentationSession>('POST', `${endpoint}/${c.id}/commands`, { token: c.writeToken, body: { commands } });
  for (const action of [{ type: 'tick', dt: 1 }, { type: 'tick', dt: -1 }, { type: 'tick', dt: 0.5, clip: c.clip }, { type: 'sendSms' }]) assert.equal((await send([{ seq: 1, action }])).status, 422);
  assert.equal((await send(Array.from({ length: 101 }, (_, i) => ({ seq: i + 1, action: { type: 'pause' } })))).status, 422);
  const reset = await send([{ seq: 1, action: { type: 'reset', scenario: 'curb', baseWall: t.now() } }]);
  assert.equal(reset.json.source.caseId, 'A2');
  assert.equal(reset.json.clip.caseId, 'A2');
  const oversize = await createApp(t.ctx).request(endpoint, { method: 'POST', body: 'x'.repeat(66000) });
  assert.equal(oversize.status, 413);
  await t.advance(86401);
  assert.equal((await t.call('GET', `${endpoint}/${c.id}`, { token: c.readToken })).status, 410);
  t.ctx.db.close();
});

test('normal experiment and noncandidate import cannot create accidents; imported evidence and sensor time survive', async () => {
  const t = await setup();
  for (const body of [{ caseId: 'D6' }, { detection: imported(false) }, { detection: imported(true) }]) {
    const { json: c } = await t.call<CreatedPresentation>('POST', endpoint, { body });
    assert.ok(c.id);
    let seq = 0;
    let session: PresentationSession = c;
    const send = async (actions: PresentationCommand['action'][]) => {
      const res = await t.call<PresentationSession>('POST', `${endpoint}/${c.id}/commands`, { token: c.writeToken, body: { commands: actions.map((action) => ({ seq: ++seq, action })) } });
      assert.equal(res.status, 200);
      session = res.json;
    };
    await send([{ type: 'autopilot', on: true }, { type: 'slowmo', on: false }, { type: 'play', driver: 'test' }]);
    await send(Array.from({ length: 100 }, () => ({ type: 'tick', dt: 0.5 })));
    await send(Array.from({ length: 100 }, () => ({ type: 'tick', dt: 0.5 })));
    if (body.detection) {
      assert.deepEqual(session.detection, body.detection);
      assert.equal(session.analysis, null);
      if (body.detection.result.candidate) {
        assert.equal(session.state.incident?.candidateClipT, 150.25);
        assert.equal(session.state.incident?.status, 'resolved');
      } else assert.equal(session.state.incident, null);
    } else assert.equal(session.state.incident, null);
  }
  assert.equal((await t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM incidents'))?.n, 0);
  assert.equal((await t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications'))?.n, 0);
  assert.deepEqual([t.sms, t.reports, t.reassigned, t.pushes], [[], [], [], []]);
  t.ctx.db.close();
});

test('presentation state survives database close and reopen', async () => {
  const t = await setup();
  const dir = await mkdtemp(join(tmpdir(), 'rider-presentation-'));
  const url = `file:${join(dir, 'sessions.db')}`;
  t.ctx.db.close();
  t.ctx.db = await Db.open(url);
  try {
    const app = createApp(t.ctx);
    const created = await app.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const c = await created.json() as CreatedPresentation;
    assert.equal(created.status, 201);
    const command = await app.request(`${endpoint}/${c.id}/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.writeToken}` },
      body: JSON.stringify({ commands: [{ seq: 1, action: { type: 'play', driver: 'persist' } }, { seq: 2, action: { type: 'tick', dt: 0.5 } }] }),
    });
    const saved = await command.json() as PresentationSession;
    assert.equal(command.status, 200);
    t.ctx.db.close();
    t.ctx.db = await Db.open(url);
    const res = await createApp(t.ctx).request(`${endpoint}/${c.id}`, { headers: { authorization: `Bearer ${c.readToken}` } });
    const session = await res.json() as PresentationSession;
    assert.equal(session.id, c.id);
    assert.deepEqual(session.state, saved.state);
    assert.equal(session.lastSequence, 2);
  } finally {
    t.ctx.db.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'rider-presentation-')));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('concurrent retries apply once, capacity is bounded, and expired command history is reclaimed', async () => {
  const t = await setup();
  const { json: c } = await t.call<CreatedPresentation>('POST', endpoint, { body: {} });
  const request = { token: c.writeToken, body: { commands: [{ seq: 1, action: { type: 'play', driver: 'race' } }, { seq: 2, action: { type: 'tick', dt: 0.5 } }] } };
  const results = await Promise.all([t.call<PresentationSession>('POST', `${endpoint}/${c.id}/commands`, request), t.call<PresentationSession>('POST', `${endpoint}/${c.id}/commands`, request)]);
  for (const result of results) { assert.equal(result.status, 200); assert.equal(result.json.state.t, 0.5); }
  assert.deepEqual(results[0]!.json, results[1]!.json);
  await t.ctx.db.run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 199)
    INSERT INTO presentationSessions (id, readHash, writeHash, sessionJson, createdAt, expiresAt)
    SELECT 'capacity-' || x, 'r', 'w', '{}', :now, :expiresAt FROM n`, { now: t.now(), expiresAt: t.now() + 86400000 });
  assert.equal((await t.call('POST', endpoint, { body: {} })).status, 429);
  await t.advance(86401);
  assert.equal((await t.call('POST', endpoint, { body: {} })).status, 201);
  assert.ok((await t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM presentationSessions'))!.n <= 200);
  // Cleanup is limited to 100 rows each time, so a second creation reclaims the remainder.
  assert.equal((await t.call('POST', endpoint, { body: {} })).status, 201);
  assert.equal((await t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM presentationCommands'))?.n, 0);
  t.ctx.db.close();
});
