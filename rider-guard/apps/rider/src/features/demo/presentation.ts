import { useSyncExternalStore } from 'react';

import { API_URL, api, ApiError } from '@/api/client';
import { type DemoAction } from '@/features/demo/engine';
import { PresentationOutbox } from '@/features/demo/presentation-outbox';
import { dispatch, getDemoState, replaceDemoState, subscribeDemoActions, TAB_ID } from '@/features/demo/store';
import type { CreatedPresentation, PresentationSession } from '../../../../../packages/demo/presentation.ts';

type Connection = {
  status: 'idle' | 'connecting' | 'connected' | 'sending' | 'retrying' | 'error';
  monitorUrl: string | null;
  sessionId: string | null;
  receivedAt: string | null;
  acknowledged: number;
  pending: number;
  message: string | null;
};
let connection: Connection = { status: 'idle', monitorUrl: null, sessionId: null, receivedAt: null, acknowledged: 0, pending: 0, message: null };
const listeners = new Set<() => void>();
let session: CreatedPresentation | null = null;
let outbox = new PresentationOutbox();
let sending = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

function update(patch: Partial<Connection>) {
  connection = { ...connection, ...patch };
  listeners.forEach((l) => l());
}

function schedule(delay = 600) {
  if (timer || !session) return;
  timer = setTimeout(() => { timer = null; void flush(); }, delay);
}

function enqueue(action: DemoAction) {
  outbox.push(action.type === 'tick' ? { type: 'tick', dt: action.dt } : action);
  update({ pending: outbox.pending });
  schedule(action.type === 'tick' ? 600 : 0);
}

async function flush() {
  if (sending || !session || !outbox.pending) return;
  const current = session;
  const queue = outbox;
  sending = true;
  if (connection.status !== 'retrying') update({ status: 'sending' });
  let retry = false;
  try {
    const received = await api<PresentationSession>('POST', `/demo-api/presentations/${current.id}/commands`, { commands: queue.batch() }, { token: current.writeToken, timeoutMs: 20_000 });
    if (session !== current) return;
    queue.acknowledge(received.lastSequence);
    update({ status: 'connected', receivedAt: received.receivedAt, acknowledged: received.lastSequence, pending: queue.pending, message: null });
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && [401, 404, 409, 410, 422, 429].includes(error.status)) {
      dispatch({ type: 'pause' });
      unsubscribe?.();
      unsubscribe = null;
      session = null;
      update({ status: 'error', sessionId: null, pending: 0, message: `${error.message} 새 발표 세션을 시작해 주세요.` });
      return;
    }
    retry = true;
    update({ status: 'retrying', message: error instanceof Error ? error.message : '서버 수신을 확인하지 못했어요.' });
    // Hold the presentation at a visible frame; the same commands are retried, never skipped.
    dispatch({ type: 'pause' });
  } finally {
    sending = false;
    if (session === current && queue.pending) schedule(retry ? 2500 : 50);
  }
}

/** Explicit start; credentials stay in this tab's memory, read-only link may be opened elsewhere. */
export async function startPresentation(automatic: boolean) {
  if (connection.status === 'connecting') return;
  if (session) {
    dispatch({ type: 'reset', baseWall: Date.now() });
    dispatch({ type: 'autopilot', on: automatic });
    if (automatic) dispatch({ type: 'play', driver: TAB_ID });
    return;
  }
  dispatch({ type: 'pause' });
  update({ status: 'connecting', message: null });
  try {
    const created = await api<CreatedPresentation>('POST', '/demo-api/presentations', { origin: 'integrated', scenario: getDemoState().scenario, baseWall: Date.now() }, { token: '', timeoutMs: 70_000 });
    session = created;
    outbox = new PresentationOutbox();
    replaceDemoState(created.state);
    unsubscribe?.();
    unsubscribe = subscribeDemoActions(enqueue);
    update({ status: 'connected', monitorUrl: `${API_URL}${created.monitorPath}`, sessionId: created.id, receivedAt: created.receivedAt, acknowledged: created.lastSequence, pending: 0 });
    dispatch({ type: 'autopilot', on: automatic });
    if (automatic) dispatch({ type: 'play', driver: TAB_ID });
  } catch (error) {
    update({ status: 'error', message: error instanceof Error ? error.message : '발표 세션을 열지 못했어요.' });
  }
}

export function retryPresentation() { void flush(); }
export const getPresentationConnection = () => connection;
export function usePresentationConnection() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => connection, () => connection);
}
