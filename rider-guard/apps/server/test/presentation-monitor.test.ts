import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import type { CreatedPresentation, PresentationAction, PresentationSession } from '../../../packages/demo/presentation.ts';
import { createApp } from '../src/app.ts';
import { setup } from './helpers.ts';

// A small DOM adapter exercises the actual shipped script with the real API. It does
// not validate layout; it checks receipt, rendering branches and command retries.
class Element {
  children: Element[] = [];
  listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  hidden = false;
  value = '';
  checked = false;
  className = '';
  private text = '';
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map((item) => item.textContent).join(''); }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; this.text = ''; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(key: string, value: (event: { preventDefault(): void }) => void) { this.listeners[key] = value; }
  querySelectorAll() { return []; }
}

const script = readFileSync(new URL('../src/presentation-console.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/presentation-console.html', import.meta.url), 'utf8');
async function settle() { for (let i = 0; i < 35; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }

function monitor(fetcher: (path: string, options: RequestInit) => Response | Promise<Response>, session?: CreatedPresentation) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const get = (id: string) => { assert.ok(elements.has(id), `Missing DOM element ${id}`); return elements.get(id)!; };
  const intro = new Element();
  const intervals: { fn: () => void; ms: number }[] = [];
  vm.runInNewContext(script, {
    document: { getElementById: get, createElement: () => new Element(), createElementNS: () => new Element(), querySelector: () => intro },
    location: { hash: session ? `#${new URLSearchParams({ session: session.id, key: session.readToken })}` : '', origin: 'https://rg.test' },
    history: { replaceState() {} }, URLSearchParams, URL, Blob, AbortController, performance,
    fetch: fetcher, setInterval(fn: () => void, ms: number) { intervals.push({ fn, ms }); return intervals.length; }, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: async () => {} } }, window: { print() {} },
  });
  return { get, interval: (ms: number) => intervals.find((item) => item.ms === ms)!.fn(), click: (id: string, type = 'click') => get(id).listeners[type]({ preventDefault() {} }) };
}

test('linked monitor refreshes evidence on same-session reset and preserves a missed candidate after reconnect', async () => {
  const h = await setup();
  try {
    const app = createApp(h.ctx);
    const { json: created } = await h.call<CreatedPresentation>('POST', '/demo-api/presentations', { body: { origin: 'integrated' } });
    const ui = monitor((path, options) => app.request(path, options), created);
    await settle();
    assert.equal(ui.get('error').hidden, true, ui.get('error').textContent);
    assert.equal(ui.get('controls').hidden, true);
    const originalEvidence = ui.get('evidence-body').textContent;
    let seq = 0;
    async function commands(actions: PresentationAction[]) {
      const response = await h.call<PresentationSession>('POST', `/demo-api/presentations/${created.id}/commands`, { token: created.writeToken, body: { commands: actions.map((action) => ({ seq: ++seq, action })) } });
      assert.equal(response.status, 200, response.text);
      ui.interval(2000);
      await settle();
    }
    await commands([{ type: 'reset', scenario: 'curb', baseWall: Date.now() }]);
    assert.match(ui.get('source-label').textContent, /D6/);
    assert.notEqual(ui.get('evidence-body').textContent, originalEvidence);
    await commands([{ type: 'autopilot', on: true }, { type: 'slowmo', on: false }, { type: 'play', driver: 'test' }, ...Array.from({ length: 40 }, (): PresentationAction => ({ type: 'tick', dt: .5 }))]);
    assert.match(ui.get('event-title').textContent, /판정이 제한/);
    assert.equal(ui.get('pipeline').children[3].className, '');
    await commands([{ type: 'reset', scenario: 'full', baseWall: Date.now() }, { type: 'sensor', lost: true }, { type: 'autopilot', on: true }, { type: 'slowmo', on: false }, { type: 'play', driver: 'test' }, ...Array.from({ length: 40 }, (): PresentationAction => ({ type: 'tick', dt: .5 })), { type: 'sensor', lost: false }]);
    assert.match(ui.get('event-title').textContent, /수신 누락/);
    assert.match(ui.get('report-summary').textContent, /판정하지 못함/);
    assert.match(ui.get('connection').textContent, /누락/);
    assert.equal(ui.get('pipeline').children[1].className, 'current');
    assert.equal(ui.get('pipeline').children[3].className, '');
  } finally { h.ctx.db.close(); }
});

test('normal measured case skips response and dispatch stages in the monitor', async () => {
  const h = await setup();
  try {
    const app = createApp(h.ctx);
    const { json: created } = await h.call<CreatedPresentation>('POST', '/demo-api/presentations', { body: { caseId: 'D7' } });
    const actions: PresentationAction[] = [{ type: 'autopilot', on: true }, { type: 'slowmo', on: false }, { type: 'play', driver: 'test' }, ...Array.from({ length: 40 }, (): PresentationAction => ({ type: 'tick', dt: .5 }))];
    const sent = await h.call('POST', `/demo-api/presentations/${created.id}/commands`, { token: created.writeToken, body: { commands: actions.map((action, index) => ({ seq: index + 1, action })) } });
    assert.equal(sent.status, 200);
    const ui = monitor((path, options) => app.request(path, options), created);
    await settle();
    assert.match(ui.get('event-title').textContent, /사고 후보 없이/);
    for (const index of [2, 3, 4]) assert.equal(ui.get('pipeline').children[index].className, '');
    assert.equal(ui.get('pipeline').children[5].className, 'done');
    assert.equal(ui.get('response-controls').hidden, true);
  } finally { h.ctx.db.close(); }
});

test('standalone monitor freezes ticks on lost response and retries the identical command batch', async () => {
  const h = await setup();
  try {
    const app = createApp(h.ctx);
    const batches: string[] = [];
    const ui = monitor(async (path, options) => {
      const response = await app.request(path, options);
      if (path.endsWith('/commands')) {
        batches.push(String(options.body));
        if (batches.length === 1) throw new Error('Response dropped after server commit');
      }
      return response;
    });
    await settle();
    ui.get('case-select').value = 'A1';
    ui.click('measured-form', 'submit');
    await settle();
    assert.equal(batches.length, 1);
    assert.match(ui.get('error').textContent, /시계를 멈췄/);
    ui.interval(200); ui.interval(200);
    await settle();
    assert.equal(batches.length, 1, 'No new tick may overtake the unacknowledged batch');
    ui.interval(2000);
    await settle();
    assert.equal(batches.length, 2);
    assert.equal(batches[1], batches[0], 'Retry preserves exact sequence and action body');
    assert.equal(ui.get('error').hidden, true);
    assert.equal(ui.get('controls').hidden, false);
    ui.interval(200);
    await settle();
    assert.equal(JSON.parse(batches[2]).commands[0].seq, 3);
  } finally { h.ctx.db.close(); }
});

test('imported evidence has no invented waveform and successful polls do not hide a stalled source', async () => {
  const h = await setup();
  try {
    const oldNow = Date.now() - 10000;
    h.ctx.clock.now = () => oldNow;
    const app = createApp(h.ctx);
    const { json: created, status } = await h.call<CreatedPresentation>('POST', '/demo-api/presentations', { body: { detection: {
      schema_version: '1.0', detection_id: 'monitor-import-001', rider_id: 'external', occurred_at: '2026-10-01T00:00:00Z',
      source: { mode: 'replay', device: 'helmet_tag', mount: 'helmet', replay: { run_id: 'run-1', scenario_id: 'external', scenario_name: '외부 기록', ground_truth: 'unknown' } },
      detector: { name: 'external', version: '1', status: 'replay', profile: 'custom', rule: { expression: 'external rule', window_s: .5, warmup_s: 0 } },
      result: { candidate: true, t_candidate_s: 7 },
      evidence: [{ key: 'impact', label: '<b>제공된 충격</b>', group: 'required', value: 7, threshold: 5, op: '>=', unit: 'g', decimals: 1, fired: true, value_basis: 'window' }],
    } } });
    assert.equal(status, 201);
    assert.equal((await h.call('POST', `/demo-api/presentations/${created.id}/commands`, { token: created.writeToken, body: { commands: [{ seq: 1, action: { type: 'play', driver: 'external-tab' } }] } })).status, 200);
    const ui = monitor((path, options) => app.request(path, options), created);
    await settle();
    assert.equal(ui.get('error').hidden, true);
    assert.equal(ui.get('waveform-wrap').hidden, true);
    assert.equal(ui.get('no-waveform').hidden, false);
    assert.match(ui.get('decision').textContent, /제공된 판정/);
    assert.match(ui.get('evidence-body').textContent, /<b>제공된 충격<\/b>/);
    assert.match(ui.get('connection').textContent, /진행 데이터 지연/);
    ui.interval(2000);
    await settle();
    assert.match(ui.get('connection').textContent, /진행 데이터 지연/);
  } finally { h.ctx.db.close(); }
});
