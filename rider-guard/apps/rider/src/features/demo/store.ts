/**
 * 시연 상태를 여러 탭이 함께 본다 — 노트북에 관제 화면, 휴대폰·다른 창에 라이더 화면을 띄워도 같은 사건·같은 시계.
 *
 *   시계를 돌리는 탭(driver) 하나가 0.1초마다 tick 하고 새 상태를 BroadcastChannel 로 뿌린다. '재생'을 누른 탭이 driver.
 *   다른 탭의 버튼은 재생 중이면 driver 에게 동작을 보내고(같은 버전 충돌 없이), 멈춘 동안에는 자기가 바로 바꾼다.
 *   마지막 상태는 localStorage 에도 둔다 — 보고서 화면과 새로 연 탭이 이어 받는다.
 * 같은 브라우저 안에서만 묶인다 (다른 기기끼리는 각자 따로 돈다).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { initialState, reduce, type DemoAction, type DemoState, type EventClip } from '@/features/demo/engine';

const CHANNEL = 'rider-guard-demo';
const KEY = 'rider-guard-demo-state';
export const TAB_ID = Math.random().toString(36).slice(2, 10);

type Message = { kind: 'state'; state: DemoState } | { kind: 'action'; action: DemoAction } | { kind: 'hello' };

const hasWindow = typeof window !== 'undefined';
const channel: BroadcastChannel | null = hasWindow && 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;

function loadStored(): DemoState | null {
  try {
    const raw = hasWindow ? window.localStorage.getItem(KEY) : null;
    if (!raw) return null;
    const s = JSON.parse(raw) as DemoState;
    // 시계를 돌리던 탭이 살아 있으면 hello 답장으로 다시 따라간다
    return typeof s?.v === 'number' && Array.isArray(s.orders) ? { ...s, playing: false, driver: null } : null;
  } catch {
    return null;
  }
}

let state: DemoState = loadStored() ?? initialState();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (persistTimer || !hasWindow) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
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
  if (broadcast) channel?.postMessage({ kind: 'state', state } satisfies Message);
}

channel?.addEventListener('message', (e: MessageEvent<Message>) => {
  const m = e.data;
  if (m.kind === 'state') {
    if (m.state.v > state.v) set(m.state, false);
  } else if (m.kind === 'action') {
    // 재생 중 다른 탭이 누른 버튼 — 시계를 돌리는 이 탭이 순서대로 반영한다
    if (state.playing && state.driver === TAB_ID) set(reduce(state, m.action), true);
  } else if (m.kind === 'hello') {
    channel.postMessage({ kind: 'state', state } satisfies Message);
  }
});
channel?.postMessage({ kind: 'hello' } satisfies Message);

export function dispatch(action: DemoAction) {
  if (state.playing && state.driver && state.driver !== TAB_ID && action.type !== 'play' && action.type !== 'tick') {
    channel?.postMessage({ kind: 'action', action } satisfies Message);
    return;
  }
  set(reduce(state, action), true);
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
  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      // 탭이 잠깐 가려져 간격이 길어져도 한 번에 크게 건너뛰지 않게
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      const c = clipRef.current;
      if (c && state.playing && state.driver === TAB_ID) dispatch({ type: 'tick', dt, clip: c });
    }, 100);
    return () => clearInterval(id);
  }, []);
}
