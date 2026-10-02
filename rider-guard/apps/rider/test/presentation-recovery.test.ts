import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

import { initialState, reduce, type DemoAction, type DemoState } from '../../../packages/demo/engine.ts';
import type { CreatedPresentation, PresentationCommand, PresentationSession } from '../../../packages/demo/presentation.ts';
import { PresentationOutbox } from '../src/features/demo/presentation-outbox.ts';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const clip = { caseId: 'A1', from: -1, to: 0.5, candidateAt: 0, decision: 'candidate' as const };
const source = (name: string) => stripTypeScriptTypes(readFileSync(new URL(`../src/features/demo/${name}.ts`, import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, ''));

function server() {
  const sessions = new Map<string, PresentationSession>();
  const commands: { id: string; commands: PresentationCommand[] }[] = [];
  const accepted = new Map<string, Map<number, string>>();
  let fail: 'before' | 'after' | null = null;
  let denied = 0;
  let heldCreate: { promise: Promise<void>; release(): void } | null = null;
  let heldCommand: { promise: Promise<void>; release(): void } | null = null;
  return {
    sessions, commands,
    failNext(mode: 'before' | 'after') { fail = mode; },
    deny(status: number) { denied = status; },
    holdCreate() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      heldCreate = { promise, release };
      return release;
    },
    holdCommand() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      heldCommand = { promise, release };
      return release;
    },
    async api(method: string, path: string, body?: { commands?: PresentationCommand[]; scenario?: DemoState['scenario']; baseWall?: number }, options?: { token?: string }) {
      if (path === '/demo-api/presentations') {
        const id = `pres_${sessions.size + 1}`;
        const result: CreatedPresentation = {
          id, state: initialState(body?.scenario ?? 'full', body?.baseWall ?? 1000), clip,
          analysis: null, detection: null, source: { kind: 'integrated', label: 'test', note: 'test', caseId: 'A1' },
          lastSequence: 0, receivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
          readToken: `read_${id}`, writeToken: `write_${id}`, monitorPath: `/ops/presentation#session=${id}&key=read_${id}`,
        };
        const { readToken: _read, writeToken: _write, monitorPath: _path, ...publicSession } = result;
        sessions.set(id, publicSession);
        accepted.set(id, new Map());
        const held = heldCreate;
        heldCreate = null;
        if (held) await held.promise;
        return structuredClone(result);
      }
      if (denied) throw new ApiError(denied, 'Session unavailable');
      const id = path.split('/')[3]!;
      const current = sessions.get(id)!;
      assert.ok(current, 'request must identify an existing session');
      assert.equal(options?.token, method === 'GET' ? `read_${id}` : `write_${id}`);
      if (method === 'GET') return structuredClone(current);
      const mode = fail;
      fail = null;
      if (mode === 'before') throw new ApiError(0, 'Network unavailable');
      const batch = structuredClone(body!.commands!);
      commands.push({ id, commands: batch });
      for (const command of batch) {
        if (command.seq <= current.lastSequence) {
          if (accepted.get(id)!.get(command.seq) !== JSON.stringify(command.action)) throw new ApiError(409, 'Conflicting command');
          continue;
        }
        assert.equal(command.seq, current.lastSequence + 1);
        current.state = reduce(current.state, command.action.type === 'tick' ? { ...command.action, clip } : command.action);
        current.lastSequence = command.seq;
        accepted.get(id)!.set(command.seq, JSON.stringify(command.action));
      }
      if (mode === 'after') throw new ApiError(0, 'Response lost');
      const held = heldCommand;
      heldCommand = null;
      if (held) await held.promise;
      return structuredClone(current);
    },
  };
}

type Connection = { status: string; canResume: boolean; monitorUrl: string | null; storageWarning: string | null; message: string | null; pending: number; acknowledged: number; sessionId: string | null };
function browserNetwork() {
  const channels = new Set<Channel>();
  const deliveries: (() => void)[] = [];
  class Channel {
    name: string;
    listener?: (event: { data: unknown }) => void;
    constructor(name: string) { this.name = name; channels.add(this); }
    addEventListener(_type: string, listener: (event: { data: unknown }) => void) { this.listener = listener; }
    postMessage(data: unknown) {
      for (const target of channels) {
        if (target === this || target.name !== this.name) continue;
        const copied = structuredClone(data);
        deliveries.push(() => { if (channels.has(target)) target.listener?.({ data: copied }); });
      }
    }
    close() { channels.delete(this); }
  }
  return { Channel, drain() {
    let count = 0;
    while (deliveries.length) { assert.ok(++count < 2000); deliveries.shift()!(); }
  } };
}

function tab(remote: ReturnType<typeof server>, sessionStorage = new MemoryStorage(), localStorage = new MemoryStorage(), blockedStorage = false, network?: ReturnType<typeof browserNetwork>, scope?: string) {
  let nextTimer = 0;
  let now = Date.now();
  let focusEffect: (() => (() => void) | void) | null = null;
  let focusCleanup: (() => void) | void;
  const timers = new Map<number, () => void>();
  const events = new Map<string, (() => void)[]>();
  const opened: string[] = [];
  const channels: { close(): void }[] = [];
  const Channel = network ? class extends network.Channel {
    constructor(name: string) { super(name); channels.push(this); }
  } : undefined;
  const window = {
    ...(Channel ? { BroadcastChannel: Channel } : {}),
    location: { search: scope ? `?presentation=${scope}` : '' },
    localStorage,
    get sessionStorage() { if (blockedStorage) throw new Error('Storage blocked'); return sessionStorage; },
    open(url: string) { opened.push(url); },
    addEventListener(name: string, callback: () => void) { events.set(name, [...(events.get(name) ?? []), callback]); },
  };
  const realm = createContext({
    window, BroadcastChannel: Channel, URL, URLSearchParams, initialState, reduce, PresentationOutbox, API_URL: 'https://api.example.test', ApiError,
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => now },
    useRef: (value: unknown) => ({ current: value }), useCallback: (callback: () => void) => callback,
    useEffect: (callback: () => void) => callback(),
    useFocusEffect(callback: () => (() => void) | void) { focusEffect = callback; focusCleanup = callback(); },
    setInterval: () => 1, clearInterval: () => undefined,
    api: remote.api.bind(remote),
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  runInContext(`(() => { ${source('store')}\nObject.assign(globalThis, { dispatch, getDemoState, replaceDemoState, restoreDemoState, subscribeDemoActions, TAB_ID, setDemoSession, getDemoSession, isDemoSessionReady, subscribeDemoSession, useDemoClock }); })();`, realm);
  realm.useDemoClock(clip);
  runInContext(`(() => { ${source('presentation')}\nObject.assign(globalThis, { startPresentation, getPresentationConnection, resumePresentation: typeof resumePresentation === 'function' ? resumePresentation : undefined, discardPresentation: typeof discardPresentation === 'function' ? discardPresentation : undefined, openPresentationReport: typeof openPresentationReport === 'function' ? openPresentationReport : undefined }); })();`, realm);
  return {
    sessionStorage, localStorage, opened,
    start: realm.startPresentation as (automatic: boolean) => Promise<void>,
    resume: realm.resumePresentation as () => Promise<void>,
    discard: realm.discardPresentation as () => void,
    report: realm.openPresentationReport as () => void,
    connection: realm.getPresentationConnection as () => Connection,
    state: realm.getDemoState as () => DemoState,
    dispatch: realm.dispatch as (action: DemoAction) => void,
    close() { channels.forEach((channel) => channel.close()); timers.clear(); },
    advance(ms: number) { now += ms; },
    pagehide() { events.get('pagehide')?.forEach((callback) => callback()); },
    blur() { focusCleanup?.(); focusCleanup = undefined; },
    focus() { if (focusEffect) focusCleanup = focusEffect(); },
    async timers() {
      const current = [...timers];
      for (const [id, callback] of current) { timers.delete(id); callback(); }
      for (let n = 0; n < 20; n++) await Promise.resolve();
    },
  };
}

for (const loss of ['before', 'after'] as const) {
  test(`reload reconciles a tick with ${loss === 'before' ? 'an undelivered request' : 'a lost response'} exactly once and pauses`, async () => {
    const remote = server();
    const first = tab(remote);
    await first.start(true);
    await first.timers();
    remote.failNext(loss);
    first.dispatch({ type: 'tick', dt: 0.5, clip });
    await first.timers();
    const restored = tab(remote, first.sessionStorage, first.localStorage);
    assert.equal(restored.connection().canResume, true);
    assert.equal(restored.connection().status, 'idle');
    await restored.resume();
    const canonical = remote.sessions.get('pres_1')!;
    assert.equal(canonical.state.t, 0.5);
    assert.equal(canonical.state.playing, false);
    assert.equal(restored.state().t, 0.5);
    assert.equal(restored.state().playing, false);
    assert.equal(restored.connection().pending, 0);
    assert.equal(restored.connection().status, 'connected');
    const ticks = remote.commands.flatMap((entry) => entry.commands).filter((command) => command.action.type === 'tick');
    assert.ok(ticks.length >= 1);
    assert.ok(ticks.every((command) => command.seq === 3 && command.action.type === 'tick' && command.action.dt === 0.5));
  });
}

test('a durable journal exists before the first request is sent and a scoped report tab receives only a read link', async () => {
  const remote = server();
  const a = tab(remote);
  await a.start(true);
  const journal = [...a.sessionStorage.values.values()].join('');
  assert.ok(journal.includes('write_pres_1'));
  assert.ok(journal.includes('play'));
  const viewer = tab(remote, new MemoryStorage(), a.localStorage, false, undefined, 'pres_1');
  assert.equal(viewer.connection().canResume, false);
  assert.equal(viewer.connection().monitorUrl, 'https://api.example.test/ops/presentation#session=pres_1&key=read_pres_1');
  viewer.report();
  assert.deepEqual(viewer.opened, ['/demo/report#session=pres_1&key=read_pres_1']);
  assert.ok(![...a.localStorage.values.values()].join('').includes('write_pres_1'));
  assert.ok(!JSON.stringify(viewer.connection()).includes('write_pres_1'));
});

test('an ahead server sequence advances the next local command without replaying old commands', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  await first.timers();
  const canonical = remote.sessions.get('pres_1')!;
  canonical.lastSequence = 9;
  canonical.state = { ...canonical.state, playing: false, driver: null, t: 7 };
  const restored = tab(remote, first.sessionStorage, first.localStorage);
  await restored.resume();
  restored.dispatch({ type: 'play', driver: 'resumed' });
  await restored.timers();
  assert.equal(remote.commands.at(-1)!.commands.at(-1)!.seq, 10);
  assert.equal(restored.state().t, 7);
});

test('a cloned tab cannot discard a conflicting pending command just because its sequence was received', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  await first.timers();
  first.dispatch({ type: 'tick', dt: 0.5, clip });
  await remote.api('POST', '/demo-api/presentations/pres_1/commands', { commands: [{ seq: 3, action: { type: 'pause' } }] }, { token: 'write_pres_1' });
  const restored = tab(remote, first.sessionStorage, first.localStorage);
  await restored.resume();
  assert.equal(restored.connection().status, 'error');
  assert.equal(restored.connection().canResume, false);
  assert.match(restored.connection().message ?? '', /새/);
});

test('an ahead acknowledgement cannot hide a conflicting command in a later journal batch', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  await first.timers();
  const copied: PresentationCommand[] = [];
  for (let index = 0; index < 120; index++) {
    first.dispatch({ type: 'tick', dt: 0.1, clip });
    copied.push({ seq: index + 3, action: index === 105 ? { type: 'pause' } : { type: 'tick', dt: 0.1 } });
  }
  await remote.api('POST', '/demo-api/presentations/pres_1/commands', { commands: copied.slice(0, 100) }, { token: 'write_pres_1' });
  await remote.api('POST', '/demo-api/presentations/pres_1/commands', { commands: copied.slice(100) }, { token: 'write_pres_1' });
  const restored = tab(remote, first.sessionStorage, first.localStorage);
  await restored.resume();
  assert.equal(restored.connection().status, 'error');
  assert.equal(restored.connection().canResume, false);
});

test('a disconnected presentation report opens the explicitly local report route', () => {
  const viewer = tab(server());
  viewer.report();
  assert.deepEqual(viewer.opened, ['/demo/report']);
});

test('a tab with its own journal retains its report identity when another session publishes a shared link', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  const second = tab(remote, new MemoryStorage(), first.localStorage);
  await second.start(false);
  const restored = tab(remote, first.sessionStorage, first.localStorage);
  assert.equal(restored.connection().monitorUrl, 'https://api.example.test/ops/presentation#session=pres_1&key=read_pres_1');
  restored.report();
  assert.deepEqual(restored.opened, ['/demo/report#session=pres_1&key=read_pres_1']);
});

test('corrupt and expired journals cannot resume and report links never accept a foreign origin', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  const key = [...first.sessionStorage.values.keys()][0]!;
  assert.ok(key);
  first.sessionStorage.setItem(key, '{broken');
  const corrupt = tab(remote, first.sessionStorage, first.localStorage);
  assert.equal(corrupt.connection().canResume, false);
  assert.match(corrupt.connection().message ?? '', /새|복구/);
  await first.start(false);
  const stored = JSON.parse(first.sessionStorage.getItem(key)!);
  stored.session.expiresAt = '2000-01-01T00:00:00.000Z';
  first.sessionStorage.setItem(key, JSON.stringify(stored));
  const expired = tab(remote, first.sessionStorage, first.localStorage);
  assert.equal(expired.connection().canResume, false);
  for (const linkKey of first.localStorage.values.keys()) first.localStorage.setItem(linkKey, 'https://attacker.test/ops/presentation#session=pres_1&key=write_pres_1');
  const viewer = tab(remote, new MemoryStorage(), first.localStorage);
  assert.equal(viewer.connection().monitorUrl, null);
});

test('blocked tab storage warns while allowing a live presentation', async () => {
  const live = tab(server(), new MemoryStorage(), new MemoryStorage(), true);
  await live.start(true);
  await live.timers();
  assert.equal(live.connection().status, 'connected');
  assert.ok(live.connection().storageWarning);
  assert.equal(live.connection().canResume, false);
});

test('a journal without its command queue is rejected instead of silently skipping pending commands', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  const key = [...first.sessionStorage.values.keys()][0]!;
  const saved = JSON.parse(first.sessionStorage.getItem(key)!);
  delete saved.outbox;
  first.sessionStorage.setItem(key, JSON.stringify(saved));
  const restored = tab(remote, first.sessionStorage, first.localStorage);
  assert.equal(restored.connection().canResume, false);
  assert.match(restored.connection().message ?? '', /새/);
});

test('a server behind already acknowledged commands cannot be silently treated as restored', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  await first.timers();
  remote.sessions.get('pres_1')!.lastSequence = 0;
  const restored = tab(remote, first.sessionStorage, first.localStorage);
  await restored.resume();
  assert.equal(restored.connection().status, 'error');
  assert.equal(restored.connection().canResume, false);
  assert.match(restored.connection().message ?? '', /새/);
});

test('expired or rejected recovery clears write authority and requires a fresh session', async () => {
  for (const status of [401, 409, 410]) {
    const remote = server();
    const first = tab(remote);
    await first.start(true);
    const restored = tab(remote, first.sessionStorage, first.localStorage);
    remote.deny(status);
    await restored.resume();
    assert.equal(restored.connection().status, 'error');
    assert.equal(restored.connection().canResume, false);
    assert.match(restored.connection().message ?? '', /새/);
    assert.ok(![...first.sessionStorage.values.values()].join('').includes('write_pres_1'));
  }
});

test('discard during session creation prevents a late response replacing a newer session', async () => {
  const remote = server();
  const live = tab(remote);
  const release = remote.holdCreate();
  const previous = live.start(true);
  live.discard();
  await live.start(false);
  release();
  await previous;
  await live.timers();
  assert.equal(live.connection().sessionId, 'pres_2');
  assert.ok(![...live.sessionStorage.values.values()].join('').includes('write_pres_1'));
  assert.ok(!remote.commands.some((entry) => entry.id === 'pres_1'));
});

test('a late command acknowledgement cannot clear a newer session queue or overwrite its identity', async () => {
  const remote = server();
  const live = tab(remote);
  await live.start(true);
  const release = remote.holdCommand();
  await live.timers();
  live.discard();
  await live.start(false);
  live.dispatch({ type: 'play', driver: 'new' });
  release();
  await live.timers();
  assert.equal(live.connection().sessionId, 'pres_2');
  assert.equal(live.connection().pending, 0);
  assert.equal(live.connection().status, 'connected');
  assert.equal(remote.sessions.get('pres_2')!.state.playing, true);
  assert.ok(![...live.sessionStorage.values.values()].join('').includes('write_pres_1'));
});

test('a failed recovery retains the exact journal and waits for an explicit retry', async () => {
  const remote = server();
  const first = tab(remote);
  await first.start(true);
  const restored = tab(remote, first.sessionStorage, first.localStorage);
  const savedCommands = [...first.sessionStorage.values.values()].join('');
  remote.failNext('before');
  await restored.resume();
  assert.equal(restored.connection().status, 'error');
  assert.equal(restored.connection().canResume, true);
  assert.equal([...first.sessionStorage.values.values()].join(''), savedCommands);
  await restored.timers();
  assert.equal(remote.sessions.get('pres_1')!.lastSequence, 0);
  await restored.resume();
  assert.equal(restored.connection().status, 'connected');
  assert.equal(restored.state().playing, false);
  assert.deepEqual(remote.commands[0]!.commands.map((command) => [command.seq, command.action.type]), [[1, 'autopilot'], [2, 'play']]);
});

test('two recovered controllers and their scoped viewers keep UI, commands, and reports on their own sessions', async () => {
  const remote = server();
  const network = browserNetwork();
  const local = new MemoryStorage();
  const firstA = tab(remote, new MemoryStorage(), local, false, network);
  await firstA.start(true);
  await firstA.timers();
  firstA.close();
  const firstB = tab(remote, new MemoryStorage(), local, false, network);
  await firstB.start(false);
  await firstB.timers();
  firstB.close();
  remote.sessions.get('pres_1')!.state = { ...remote.sessions.get('pres_1')!.state, t: 12, playing: false, driver: null };
  remote.sessions.get('pres_2')!.state = { ...remote.sessions.get('pres_2')!.state, t: 3, playing: false, driver: null };

  const a = tab(remote, firstA.sessionStorage, local, false, network);
  const b = tab(remote, firstB.sessionStorage, local, false, network);
  await a.resume();
  network.drain();
  await b.resume();
  network.drain();
  assert.equal(a.state().t, 12);
  assert.equal(b.state().t, 3);
  const viewA = tab(remote, new MemoryStorage(), local, false, network, 'pres_1');
  const viewB = tab(remote, new MemoryStorage(), local, false, network, 'pres_2');
  network.drain();
  assert.equal(viewA.state().t, 12);
  assert.equal(viewB.state().t, 3);
  viewA.dispatch({ type: 'play', driver: 'viewer-a' });
  viewB.dispatch({ type: 'play', driver: 'viewer-b' });
  network.drain();
  a.dispatch({ type: 'tick', dt: 0.5, clip });
  b.dispatch({ type: 'tick', dt: 0.5, clip });
  network.drain();
  await a.timers();
  await b.timers();
  assert.equal(remote.sessions.get('pres_1')!.state.t, 12.5);
  assert.equal(remote.sessions.get('pres_2')!.state.t, 3.5);
  for (const client of [a, viewA]) assert.equal(client.state().t, 12.5);
  for (const client of [b, viewB]) assert.equal(client.state().t, 3.5);
  viewA.report();
  viewB.report();
  assert.deepEqual(viewA.opened, ['/demo/report#session=pres_1&key=read_pres_1']);
  assert.deepEqual(viewB.opened, ['/demo/report#session=pres_2&key=read_pres_2']);
  assert.equal(remote.commands.flatMap((entry) => entry.commands).filter((command) => command.action.type === 'reset').length, 0);
});

test('a scoped viewer ignores a cloned journal and cannot mutate while its controller awaits recovery', async () => {
  const remote = server();
  const network = browserNetwork();
  const original = tab(remote, new MemoryStorage(), new MemoryStorage(), false, network);
  await original.start(true);
  await original.timers();
  original.close();
  const owner = tab(remote, original.sessionStorage, original.localStorage, false, network);
  const copied = new MemoryStorage();
  for (const [key, value] of original.sessionStorage.values) copied.setItem(key, value);
  const view = tab(remote, copied, original.localStorage, false, network, 'pres_1');
  network.drain();
  assert.equal(view.connection().canResume, false);
  assert.equal(view.connection().status, 'restoring');
  view.dispatch({ type: 'play', driver: 'viewer' });
  network.drain();
  assert.equal(owner.state().playing, false);
  await owner.resume();
  network.drain();
  assert.equal(view.connection().status, 'idle');
  assert.equal(view.state().playing, false);
});

test('a scoped report without a read link never opens an unrelated local report', () => {
  const view = tab(server(), new MemoryStorage(), new MemoryStorage(), false, undefined, 'pres_missing');
  view.report();
  assert.deepEqual(view.opened, []);
  assert.equal(view.connection().sessionId, 'pres_missing');
  assert.match(view.connection().message ?? '', /원본|읽기/);
});

test('an unconnected local replay does not inherit a report from another presentation scope', async () => {
  const remote = server();
  const original = tab(remote);
  await original.start(true);
  const local = tab(remote, new MemoryStorage(), original.localStorage);
  local.report();
  assert.equal(local.connection().monitorUrl, null);
  assert.deepEqual(local.opened, ['/demo/report']);
});

test('paused owners keep viewers available, while an abruptly closed owner expires its viewer lease', async () => {
  const remote = server();
  const network = browserNetwork();
  const owner = tab(remote, new MemoryStorage(), new MemoryStorage(), false, network);
  await owner.start(false);
  const view = tab(remote, new MemoryStorage(), owner.localStorage, false, network, 'pres_1');
  network.drain();
  for (let interval = 0; interval < 5; interval++) {
    owner.advance(2000);
    view.advance(2000);
    await owner.timers();
    network.drain();
    await view.timers();
    network.drain();
    assert.equal(view.connection().status, 'idle');
  }
  owner.close();
  view.advance(8000);
  await view.timers();
  network.drain();
  assert.equal(view.connection().status, 'restoring');
  view.dispatch({ type: 'play', driver: 'absent-owner' });
  network.drain();
  assert.equal(view.state().playing, false);
  assert.equal(remote.sessions.get('pres_1')!.state.playing, false);
});

test('pagehide immediately withdraws viewer controls and durably pauses the owner', async () => {
  const remote = server();
  const network = browserNetwork();
  const owner = tab(remote, new MemoryStorage(), new MemoryStorage(), false, network);
  await owner.start(true);
  await owner.timers();
  const view = tab(remote, new MemoryStorage(), owner.localStorage, false, network, 'pres_1');
  network.drain();
  owner.pagehide();
  network.drain();
  assert.equal(view.connection().status, 'restoring');
  assert.equal(owner.state().playing, false);
  assert.ok([...owner.sessionStorage.values.values()].join('').includes('pause'));
});

test('route blur stops a retained owner clock and locks viewers; focus returns paused availability', async () => {
  const remote = server();
  const network = browserNetwork();
  const owner = tab(remote, new MemoryStorage(), new MemoryStorage(), false, network);
  await owner.start(true);
  await owner.timers();
  const view = tab(remote, new MemoryStorage(), owner.localStorage, false, network, 'pres_1');
  network.drain();
  view.blur();
  network.drain();
  assert.equal(owner.state().playing, true, 'a viewing route cannot pause its owner');
  owner.blur();
  network.drain();
  assert.equal(owner.state().playing, false);
  assert.equal(view.connection().status, 'restoring');
  await owner.timers();
  network.drain();
  assert.equal(remote.sessions.get('pres_1')!.state.playing, false);
  assert.equal(view.connection().status, 'restoring', 'a background acknowledgement cannot reactivate a blurred host');
  owner.focus();
  network.drain();
  assert.equal(view.connection().status, 'idle');
  assert.equal(owner.state().playing, false);
});
