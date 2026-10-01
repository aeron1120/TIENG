import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

import { initialState, reduce, type DemoAction, type DemoState, type EventClip } from '../../../packages/demo/engine.ts';

type Store = {
  TAB_ID: string;
  dispatch(action: DemoAction): void;
  getDemoState(): DemoState;
  replaceDemoState(state: DemoState): void;
  subscribeDemoActions(listener: (action: DemoAction) => void): () => void;
};

// Exercise the real store in separate browser realms without React or a DOM.
// Only its imports/exports are adapted; state transitions use the shared engine.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/features/demo/store.ts', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, ''))
  + '\nglobalThis.store = { TAB_ID, dispatch, getDemoState, replaceDemoState, subscribeDemoActions };';

function browser() {
  const channels: Channel[] = [];
  const deliveries: (() => void)[] = [];
  class Channel {
    readonly name: string;
    listener?: (event: { data: unknown }) => void;
    constructor(name: string) { this.name = name; channels.push(this); }
    addEventListener(_type: string, listener: (event: { data: unknown }) => void) { this.listener = listener; }
    postMessage(data: unknown) {
      for (const channel of channels) {
        if (channel === this || channel.name !== this.name) continue;
        const copy = structuredClone(data);
        deliveries.push(() => channel.listener?.({ data: copy }));
      }
    }
  }
  return {
    tab(): Store {
      const realm = createContext({
        initialState, reduce, BroadcastChannel: Channel,
        window: { BroadcastChannel: Channel, localStorage: { getItem: () => null, setItem: () => undefined } },
        setTimeout: () => 1,
      });
      runInContext(source, realm);
      return realm.store as Store;
    },
    drain() {
      let count = 0;
      while (deliveries.length) {
        assert.ok(++count < 1000, 'broadcast delivery must settle');
        deliveries.shift()!();
      }
    },
  };
}

function serverMirror(store: Store, initial: DemoState) {
  let state = initial;
  const actions: DemoAction[] = [];
  store.subscribeDemoActions((action) => {
    actions.push(structuredClone(action));
    state = reduce(state, action);
  });
  return { state: () => state, actions };
}

const clip: EventClip = { caseId: 'A1', from: -1, to: 0.5, candidateAt: 0, decision: 'candidate' };
const replayState = ({ v: _version, ...state }: DemoState) => JSON.parse(JSON.stringify(state));

test('a fresh presentation in a second tab resets existing server mirrors before subsequent commands', () => {
  const tabs = browser();
  const a = tabs.tab();
  const first = initialState('full', 1000);
  a.replaceDemoState(first);
  const serverA = serverMirror(a, first);
  a.dispatch({ type: 'autopilot', on: true });
  a.dispatch({ type: 'play', driver: a.TAB_ID });
  for (let n = 0; n < 10; n++) a.dispatch({ type: 'tick', dt: 0.5, clip });
  assert.equal(serverA.state().t, 5);

  const b = tabs.tab();
  tabs.drain();
  b.dispatch({ type: 'pause' });
  tabs.drain();
  const second = initialState('full', 2000);
  b.replaceDemoState(second);
  // Match startPresentation: the new session subscribes after state replacement.
  const serverB = serverMirror(b, second);
  b.dispatch({ type: 'autopilot', on: true });
  b.dispatch({ type: 'play', driver: b.TAB_ID });
  b.dispatch({ type: 'tick', dt: 0.1, clip });
  tabs.drain();

  assert.equal(serverA.state().t, 0.1);
  assert.equal(serverA.state().baseWall, 2000);
  assert.deepEqual(serverA.actions.filter((action) => action.type === 'reset'), [{ type: 'reset', scenario: 'full', baseWall: 2000 }]);
  assert.equal(serverB.actions.filter((action) => action.type === 'reset').length, 0);
  for (const state of [a.getDemoState(), b.getDemoState(), serverA.state()]) {
    assert.deepEqual(replayState(state), replayState(serverB.state()));
  }
});

test('a response from a viewing tab is applied by the driver and forwarded to each server exactly once', () => {
  const tabs = browser();
  const a = tabs.tab();
  const initial = initialState('full', 1000);
  a.replaceDemoState(initial);
  const b = tabs.tab();
  tabs.drain();
  const serverA = serverMirror(a, initial);
  const serverB = serverMirror(b, initial);
  a.dispatch({ type: 'slowmo', on: false });
  a.dispatch({ type: 'play', driver: a.TAB_ID });
  for (let n = 0; n < 14; n++) a.dispatch({ type: 'tick', dt: 0.5, clip });
  tabs.drain();
  assert.equal(b.getDemoState().incident?.status, 'confirming');

  b.dispatch({ type: 'respond', response: 'help' });
  assert.equal(b.getDemoState().incident?.status, 'confirming');
  tabs.drain();
  assert.equal(serverA.state().incident?.status, 'escalated');
  for (const server of [serverA, serverB]) assert.equal(server.actions.filter((action) => action.type === 'respond').length, 1);
  for (const state of [a.getDemoState(), b.getDemoState(), serverA.state()]) {
    assert.deepEqual(replayState(state), replayState(serverB.state()));
  }

  // An invalid repeat must not be forwarded as another applied response.
  b.dispatch({ type: 'respond', response: 'help' });
  tabs.drain();
  for (const server of [serverA, serverB]) assert.equal(server.actions.filter((action) => action.type === 'respond').length, 1);
});
