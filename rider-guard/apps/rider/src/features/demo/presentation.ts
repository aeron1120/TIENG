import { useSyncExternalStore } from 'react';

import { API_URL, api, ApiError } from '@/api/client';
import { type DemoAction } from '@/features/demo/engine';
import { PresentationOutbox, type OutboxSnapshot } from '@/features/demo/presentation-outbox';
import { dispatch, getDemoSession, getDemoState, isDemoSessionReady, replaceDemoState, restoreDemoState, setDemoSession, subscribeDemoActions, subscribeDemoSession, TAB_ID } from '@/features/demo/store';
import type { CreatedPresentation, PresentationSession } from '../../../../../packages/demo/presentation.ts';

type Connection = {
  status: 'idle' | 'connecting' | 'restoring' | 'connected' | 'sending' | 'retrying' | 'error';
  monitorUrl: string | null;
  sessionId: string | null;
  receivedAt: string | null;
  acknowledged: number;
  pending: number;
  message: string | null;
  canResume: boolean;
  storageWarning: string | null;
};
type Credentials = Pick<CreatedPresentation, 'id' | 'readToken' | 'writeToken' | 'expiresAt'>;
type Journal = { version: 1; session: Credentials; outbox: OutboxSnapshot };
const JOURNAL_KEY = 'rider-guard-presentation-journal-v1';
const REPORT_KEY = 'rider-guard-presentation-read-link';
const STORAGE_WARNING = '이 탭의 저장소를 사용할 수 없어 새로고침 후 복구할 수 없어요. 현재 시연은 계속할 수 있어요.';
const hasBrowser = typeof window !== 'undefined';
const observerScope = getDemoSession();
let connection: Connection = { status: 'idle', monitorUrl: null, sessionId: null, receivedAt: null, acknowledged: 0, pending: 0, message: null, canResume: false, storageWarning: null };
const listeners = new Set<() => void>();
let session: Credentials | null = null;
let recovery: Journal | null = null;
let outbox = new PresentationOutbox();
let generation = 0;
let sending: object | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

function update(patch: Partial<Connection>) {
  connection = { ...connection, ...patch };
  listeners.forEach((listener) => listener());
}

function monitorUrl(current: Credentials) {
  return `${API_URL}/ops/presentation#session=${encodeURIComponent(current.id)}&key=${encodeURIComponent(current.readToken)}`;
}

/** Shared storage carries a read capability only, restricted to our monitor. */
function safeReportUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const expected = new URL(`${API_URL}/ops/presentation`);
    const hash = new URLSearchParams(url.hash.slice(1));
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.search || url.username || url.password
      || [...hash.keys()].length !== 2 || !/^[A-Za-z0-9_-]{1,128}$/.test(hash.get('session') ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(hash.get('key') ?? '')) return null;
    return url.href;
  } catch { return null; }
}

function shareReport(current: Credentials) {
  try {
    if (hasBrowser) {
      window.localStorage.setItem(`${REPORT_KEY}:${current.id}`, monitorUrl(current));
      window.localStorage.setItem(REPORT_KEY, monitorUrl(current));
    }
  } catch { /* The current tab still has the link. */ }
}

function sharedReport(scope: string | null) {
  if (!hasBrowser || !scope) return null;
  try {
    const scoped = scope ? safeReportUrl(window.localStorage.getItem(`${REPORT_KEY}:${scope}`)) : null;
    const url = scoped ?? safeReportUrl(window.localStorage.getItem(REPORT_KEY));
    return url && (!scope || new URLSearchParams(new URL(url).hash.slice(1)).get('session') === scope) ? url : null;
  } catch { return null; }
}

function updateObserver() {
  if (!observerScope || getDemoSession() !== observerScope || session || recovery) return;
  const ready = isDemoSessionReady();
  update({ status: ready ? 'idle' : 'restoring', sessionId: observerScope, canResume: false, monitorUrl: sharedReport(observerScope), message: ready ? null : '원본 발표 탭에서 연결·복구를 마칠 때까지 기다려 주세요. 원본 탭을 열어 두어야 조작할 수 있어요.' });
}

function removeJournal() {
  try { if (hasBrowser) window.sessionStorage.removeItem(JOURNAL_KEY); } catch { update({ storageWarning: STORAGE_WARNING }); }
}

/** Synchronous write precedes every request, including its fixed sequence numbers. */
function persist(current: Credentials, queue: PresentationOutbox) {
  const saved: Journal = { version: 1, session: current, outbox: queue.snapshot() };
  try {
    if (hasBrowser) window.sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(saved));
  } catch {
    // Never offer a stale journal after a quota failure.
    removeJournal();
    update({ storageWarning: STORAGE_WARNING });
  }
  return saved;
}

function loadRecovery() {
  if (!hasBrowser) return;
  connection.monitorUrl = sharedReport(observerScope);
  // Explicit standalone links are observers even if the browser copied an opener's journal.
  if (observerScope) { updateObserver(); return; }
  let raw: string | null;
  try { raw = window.sessionStorage.getItem(JOURNAL_KEY); } catch {
    connection.storageWarning = STORAGE_WARNING;
    return;
  }
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as Journal;
    const candidate = saved?.session;
    if (saved.version !== 1 || !candidate || !saved.outbox || ![candidate.id, candidate.readToken, candidate.writeToken].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))
      || !Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= Date.now()) throw new Error('Invalid or expired journal');
    const queue = new PresentationOutbox(saved.outbox);
    // Whitelist fields: capabilities never travel with a demo snapshot or report.
    const current = { id: candidate.id, readToken: candidate.readToken, writeToken: candidate.writeToken, expiresAt: candidate.expiresAt };
    recovery = { version: 1, session: current, outbox: queue.snapshot() };
    setDemoSession(current.id, true, false);
    connection = { ...connection, canResume: true, sessionId: current.id, monitorUrl: monitorUrl(current), pending: queue.pending, message: '이 탭의 발표가 남아 있어요. 서버 상태를 확인해 이어가거나 새로 시작할 수 있어요.' };
  } catch {
    removeJournal();
    connection.message = '저장된 발표가 만료됐거나 복구 자료를 읽을 수 없어요. 새 발표 세션을 시작해 주세요.';
  }
}

function detach() {
  if (timer) clearTimeout(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
  sending = null;
}

function terminal(error: unknown) {
  return error instanceof ApiError && [401, 404, 409, 410, 422, 429].includes(error.status);
}

function invalidate(error: unknown) {
  detach();
  session = null;
  recovery = null;
  outbox = new PresentationOutbox();
  removeJournal();
  dispatch({ type: 'pause' });
  setDemoSession(getDemoSession(), true, false);
  update({ status: 'error', sessionId: null, pending: 0, canResume: false, message: `${error instanceof Error ? error.message : '발표를 복구할 수 없어요.'} 새 발표 세션을 시작해 주세요.` });
}

function schedule(delay = 600) {
  if (timer || !session || connection.status === 'restoring') return;
  const epoch = generation;
  timer = setTimeout(() => { timer = null; if (epoch === generation) void flush(); }, delay);
}

function enqueue(action: DemoAction) {
  if (!session) return;
  outbox.push(action.type === 'tick' ? { type: 'tick', dt: action.dt } : action);
  persist(session, outbox);
  update({ pending: outbox.pending });
  schedule(action.type === 'tick' ? 600 : 0);
}

async function send(current: Credentials, queue: PresentationOutbox) {
  const batch = queue.batch();
  const received = await api<PresentationSession>('POST', `/demo-api/presentations/${current.id}/commands`, { commands: batch }, { token: current.writeToken, timeoutMs: 20_000 });
  if (received.lastSequence < batch.at(-1)!.seq) throw new Error('서버에서 마지막 명령의 수신을 확인하지 못했어요.');
  return { received, through: batch.at(-1)!.seq };
}

async function flush() {
  if (sending || !session || !outbox.pending || connection.status === 'restoring') return;
  const current = session;
  const queue = outbox;
  const flight = {};
  sending = flight;
  if (connection.status !== 'retrying') update({ status: 'sending' });
  let retry = false;
  try {
    const { received, through } = await send(current, queue);
    if (session !== current) return;
    queue.acknowledge(through);
    if (!queue.pending) queue.reconcile(received.lastSequence);
    persist(current, queue);
    setDemoSession(current.id, true, true);
    update({ status: 'connected', receivedAt: received.receivedAt, acknowledged: received.lastSequence, pending: queue.pending, message: null });
  } catch (error) {
    if (session !== current) return;
    if (terminal(error)) { invalidate(error); return; }
    retry = true;
    update({ status: 'retrying', message: error instanceof Error ? error.message : '서버 수신을 확인하지 못했어요.' });
    dispatch({ type: 'pause' });
    setDemoSession(current.id, true, false);
  } finally {
    if (sending === flight) sending = null;
    if (session === current && queue.pending) schedule(retry ? 2500 : 50);
  }
}

/** Explicit start; write authority is retained only in this tab's sessionStorage. */
export async function startPresentation(automatic: boolean) {
  if (connection.status === 'connecting' || connection.status === 'restoring') return;
  if (session) {
    dispatch({ type: 'reset', baseWall: Date.now() });
    dispatch({ type: 'autopilot', on: automatic });
    if (automatic) dispatch({ type: 'play', driver: TAB_ID });
    return;
  }
  if (recovery) discardPresentation();
  const epoch = ++generation;
  const scenario = getDemoState().scenario;
  setDemoSession(`pending_${TAB_ID}`, true, false);
  update({ status: 'connecting', message: null, canResume: false });
  try {
    const created = await api<CreatedPresentation>('POST', '/demo-api/presentations', { origin: 'integrated', scenario, baseWall: Date.now() }, { token: '', timeoutMs: 70_000 });
    if (epoch !== generation) return;
    session = { id: created.id, readToken: created.readToken, writeToken: created.writeToken, expiresAt: created.expiresAt };
    outbox = new PresentationOutbox();
    outbox.reconcile(created.lastSequence);
    persist(session, outbox);
    shareReport(session);
    setDemoSession(session.id, true, false);
    replaceDemoState(created.state);
    unsubscribe?.();
    unsubscribe = subscribeDemoActions(enqueue);
    setDemoSession(session.id, true, true);
    update({ status: 'connected', monitorUrl: monitorUrl(session), sessionId: created.id, receivedAt: created.receivedAt, acknowledged: created.lastSequence, pending: 0, canResume: false });
    dispatch({ type: 'autopilot', on: automatic });
    if (automatic) dispatch({ type: 'play', driver: TAB_ID });
  } catch (error) {
    if (epoch !== generation) return;
    update({ status: 'error', message: error instanceof Error ? error.message : '발표 세션을 열지 못했어요.' });
  }
}

/** Read, verify/replay fixed pending commands, then install the paused server snapshot. */
export async function resumePresentation() {
  if (!recovery || session || connection.status === 'restoring' || connection.status === 'connecting') return;
  const epoch = ++generation;
  const current = recovery.session;
  const queue = new PresentationOutbox(recovery.outbox);
  detach();
  setDemoSession(current.id, true, false);
  session = current;
  outbox = queue;
  update({ status: 'restoring', canResume: false, message: '서버에서 수신한 순번과 사건 상태를 확인하고 있어요.' });
  const active = () => epoch === generation && session === current;
  const read = () => api<PresentationSession>('GET', `/demo-api/presentations/${current.id}`, undefined, { token: current.readToken, timeoutMs: 20_000 });
  try {
    let received = await read();
    if (!active()) return;
    if (received.lastSequence < queue.snapshot().sequence - queue.pending) throw new ApiError(409, 'sequence_conflict', '서버 순번과 저장된 수신 기록이 달라요.');
    // A sequence alone cannot prove a cloned tab sent the same command. The
    // idempotent endpoint verifies its stored hash before we discard any entry.
    while (queue.pending) {
      const result = await send(current, queue);
      if (!active()) return;
      received = result.received;
      queue.acknowledge(result.through);
      recovery = persist(current, queue);
    }
    queue.reconcile(received.lastSequence);
    recovery = persist(current, queue);
    if (received.state.playing) {
      queue.push({ type: 'pause' });
      recovery = persist(current, queue);
      const result = await send(current, queue);
      if (!active()) return;
      received = result.received;
      queue.acknowledge(result.through);
      queue.reconcile(received.lastSequence);
      recovery = persist(current, queue);
    }
    received = await read();
    if (!active()) return;
    queue.reconcile(received.lastSequence);
    persist(current, queue);
    restoreDemoState({ ...received.state, playing: false, driver: null });
    recovery = null;
    shareReport(current);
    unsubscribe = subscribeDemoActions(enqueue);
    setDemoSession(current.id, true, true);
    update({ status: 'connected', monitorUrl: monitorUrl(current), sessionId: current.id, receivedAt: received.receivedAt, acknowledged: received.lastSequence, pending: 0, canResume: false, message: '서버 상태를 복구했어요. 일시정지 상태에서 이어서 재생할 수 있어요.' });
  } catch (error) {
    if (!active()) return;
    if (terminal(error)) { invalidate(error); return; }
    recovery = persist(current, queue);
    session = null;
    update({ status: 'error', canResume: true, pending: queue.pending, message: '서버 상태를 확인하지 못했어요. 연결을 확인한 뒤 다시 이어가기를 눌러 주세요.' });
  }
}

export function discardPresentation() {
  generation++;
  detach();
  session = null;
  recovery = null;
  outbox = new PresentationOutbox();
  removeJournal();
  try { if (hasBrowser && window.localStorage.getItem(REPORT_KEY) === connection.monitorUrl) window.localStorage.removeItem(REPORT_KEY); } catch { /* Optional sharing. */ }
  dispatch({ type: 'pause' });
  setDemoSession(null, false);
  update({ status: 'idle', monitorUrl: null, sessionId: null, receivedAt: null, acknowledged: 0, pending: 0, message: null, canResume: false });
}

export function openPresentationReport() {
  if (!hasBrowser) return;
  const scope = getDemoSession();
  if (!connection.monitorUrl && scope && !scope.startsWith('pending_')) {
    update({ message: '이 발표의 읽기 링크를 가져오지 못했어요. 원본 발표 탭에서 보고서를 열어 주세요.' });
    return;
  }
  window.open(connection.monitorUrl ?? '/demo/report', '_blank', 'noopener,noreferrer');
}

loadRecovery();
subscribeDemoSession(updateObserver);
if (hasBrowser) window.addEventListener('storage', (event) => {
  if (!session && !recovery && (event.key === REPORT_KEY || event.key === `${REPORT_KEY}:${observerScope}`)) update({ monitorUrl: sharedReport(observerScope) });
});

export function retryPresentation() { if (recovery && !session) void resumePresentation(); else void flush(); }
export const getPresentationConnection = () => connection;
export function usePresentationConnection() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => connection, () => connection);
}
