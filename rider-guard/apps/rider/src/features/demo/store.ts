/**
 * 시연 상태를 여러 탭이 함께 본다 — 노트북에 관제 화면, 휴대폰·다른 창에 라이더 화면을 띄워도 같은 사건·같은 시계.
 *
 *   시계를 돌리는 탭(driver) 하나가 0.1초마다 tick 하고 새 상태를 BroadcastChannel 로 뿌린다. '재생'을 누른 탭이 driver.
 *   다른 탭의 버튼은 재생 중이면 driver 에게 동작을 보내고(같은 버전 충돌 없이), 멈춘 동안에는 자기가 바로 바꾼다.
 *   마지막 상태는 localStorage 에도 둔다 — 보고서 화면과 새로 연 탭이 이어 받는다.
 * 서버에 연결된 발표는 세션별로 격리한다. 같은 세션의 별도 화면만 원본 탭을 따라간다.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { initialState, reduce, type DemoAction, type DemoState, type EventClip } from '@/features/demo/engine';

const CHANNEL = 'rider-guard-demo';
const KEY = 'rider-guard-demo-state';
export const TAB_ID = Math.random().toString(36).slice(2, 10);

type Payload = { kind: 'state'; state: DemoState } | { kind: 'action'; action: DemoAction } | { kind: 'applied'; action: DemoAction } | { kind: 'hello' } | { kind: 'availability' };
type Message = Payload & { scope: string | null; sender: string; controller: boolean; ready: boolean };

const hasWindow = typeof window !== 'undefined';
const channel: BroadcastChannel | null = hasWindow && 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;
const requested = hasWindow ? new URLSearchParams(window.location?.search ?? '').get('presentation') : null;
let scope: string | null = requested && /^[A-Za-z0-9_-]{1,128}$/.test(requested) ? requested : null;
let controller = false;
let ownerReady = false;
let remoteReady = false;
let remoteSeenAt = 0;
let focusedClocks = 0;
let pageActive = true;
let leader: string | null = null;
const sessionListeners = new Set<() => void>();
const storageKey = () => scope ? `${KEY}:${scope}` : KEY;
const ownerAvailable = () => ownerReady && focusedClocks > 0 && pageActive;
const post = (payload: Payload) => channel?.postMessage({ ...payload, scope, sender: TAB_ID, controller, ready: ownerAvailable() } satisfies Message);

function publishAvailability() {
  sessionListeners.forEach((listener) => listener());
  if (controller) post(ownerAvailable() ? { kind: 'state', state } : { kind: 'availability' });
}

function checkPresence() {
  if (controller) post({ kind: 'availability' });
  else if (scope && remoteReady && Date.now() - remoteSeenAt > 6000) {
    remoteReady = false;
    sessionListeners.forEach((listener) => listener());
  }
  setTimeout(checkPresence, 2000);
}

function loadStored(): DemoState | null {
  try {
    const raw = hasWindow ? window.localStorage.getItem(storageKey()) : null;
    if (!raw) return null;
    const s = JSON.parse(raw) as DemoState;
    // 시계를 돌리던 탭이 살아 있으면 hello 답장으로 다시 따라간다
    return typeof s?.v === 'number' && Array.isArray(s.orders) ? { ...s, autoPilot: s.autoPilot ?? false, playing: false, driver: null } : null;
  } catch {
    return null;
  }
}

let state: DemoState = loadStored() ?? initialState();
const listeners = new Set<() => void>();
const actionListeners = new Set<(action: DemoAction) => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (persistTimer || !hasWindow) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(state));
    } catch {
      // 저장소를 쓸 수 없으면(사생활 보호 창 등) 이 탭에서만 돈다
    }
  }, 400);
}

function set(next: DemoState, broadcast: boolean) {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
  persist();
  if (broadcast) post({ kind: 'state', state });
}

function applyAction(action: DemoAction) {
  const next = reduce(state, action);
  if (next === state) return;
  set(next, true);
  actionListeners.forEach((listener) => listener(action));
  post({ kind: 'applied', action });
}

channel?.addEventListener('message', (e: MessageEvent<Message>) => {
  const m = e.data;
  if (m.scope !== scope || (controller && m.controller)) return;
  if (scope && !controller && m.controller && (m.kind === 'state' || m.kind === 'availability')) {
    remoteSeenAt = Date.now();
    if (remoteReady !== m.ready) {
      remoteReady = m.ready;
      sessionListeners.forEach((listener) => listener());
    }
  }
  if (m.kind === 'state') {
    if (controller || (scope && !m.controller)) return;
    if ((scope && leader !== m.sender) || m.state.v > state.v) set(m.state, false);
    leader = m.sender;
  } else if (m.kind === 'action') {
    // 재생 중 다른 탭이 누른 버튼 — 시계를 돌리는 이 탭이 순서대로 반영한다
    if (scope) {
      if (controller && ownerAvailable() && !m.controller) applyAction(m.action.type === 'play' ? { ...m.action, driver: TAB_ID } : m.action);
    } else if (state.playing && state.driver === TAB_ID) applyAction(m.action);
  } else if (m.kind === 'applied') {
    if (!controller) actionListeners.forEach((listener) => listener(m.action));
  } else if (m.kind === 'hello') {
    if (!scope || (controller && ownerAvailable())) post({ kind: 'state', state });
    else if (controller) post({ kind: 'availability' });
  }
});
post({ kind: 'hello' });
if (channel) setTimeout(checkPresence, 2000);
if (hasWindow) {
  window.addEventListener?.('pagehide', () => {
    if (controller || !scope) dispatch({ type: 'pause' });
    pageActive = false;
    publishAvailability();
  });
  window.addEventListener?.('pageshow', () => {
    pageActive = true;
    publishAvailability();
  });
}

/** Pin a writer before any recovery work; observers never acquire write authority. */
export function setDemoSession(id: string | null, isController: boolean, ready = true) {
  const changed = scope !== id || controller !== isController;
  if (changed && controller) {
    ownerReady = false;
    post({ kind: 'availability' });
  }
  scope = id;
  controller = isController;
  ownerReady = isController && ready;
  if (changed) {
    leader = null;
    remoteReady = false;
    state = { ...state, playing: false, driver: null, v: state.v + 1 };
    listeners.forEach((listener) => listener());
  }
  sessionListeners.forEach((listener) => listener());
  if (controller) post(ownerAvailable() ? { kind: 'state', state } : { kind: 'availability' });
  else post({ kind: 'hello' });
}

export const getDemoSession = () => scope;
export const isDemoSessionReady = () => !scope || (controller ? ownerAvailable() : remoteReady);
export function subscribeDemoSession(listener: () => void) {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}
export function demoViewPath(path: string) {
  return scope && !scope.startsWith('pending_') ? `${path}${path.includes('?') ? '&' : '?'}presentation=${encodeURIComponent(scope)}` : path;
}

export function dispatch(action: DemoAction) {
  if (scope) {
    if (!controller) {
      if (remoteReady) post({ kind: 'action', action });
      return;
    }
    if (!ownerAvailable()) return;
    applyAction(action.type === 'play' ? { ...action, driver: TAB_ID } : action);
    return;
  }
  if (state.playing && state.driver && state.driver !== TAB_ID && action.type !== 'play' && action.type !== 'tick') {
    post({ kind: 'action', action });
    return;
  }
  applyAction(action);
}

/** A connection starts from the server's fresh state without replaying a stale local incident. */
export function replaceDemoState(next: DemoState) {
  set({ ...next, v: state.v + 1 }, true);
  // Local-only mirrors still need the reset action; scoped writers ignore peer events.
  const action: DemoAction = { type: 'reset', scenario: next.scenario, baseWall: next.baseWall };
  actionListeners.forEach((listener) => listener(action));
  post({ kind: 'applied', action });
}

/** Snapshot reconciliation is not a new incident and must never enqueue a reset. */
export function restoreDemoState(next: DemoState) {
  set({ ...next, v: state.v + 1 }, true);
}

export function subscribeDemoActions(listener: (action: DemoAction) => void) {
  actionListeners.add(listener);
  return () => { actionListeners.delete(listener); };
}

export const getDemoState = () => state;

export function useDemoState(): DemoState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** 이 탭이 driver 면 시계를 돌린다. clip 은 사건 파형(서버 판정 결과)이 준비됐을 때만 */
export function useDemoClock(clip: EventClip | null) {
  const clipRef = useRef(clip);
  useEffect(() => {
    clipRef.current = clip;
  }, [clip]);
  useFocusEffect(useCallback(() => {
    focusedClocks++;
    publishAvailability();
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      // 탭이 잠깐 가려져 간격이 길어져도 한 번에 크게 건너뛰지 않게
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      const c = clipRef.current;
      if (c && state.playing && state.driver === TAB_ID) dispatch({ type: 'tick', dt, clip: c });
    }, 100);
    return () => {
      clearInterval(id);
      if (focusedClocks === 1 && (controller || !scope)) dispatch({ type: 'pause' });
      focusedClocks = Math.max(0, focusedClocks - 1);
      publishAvailability();
    };
  }, []));
}
