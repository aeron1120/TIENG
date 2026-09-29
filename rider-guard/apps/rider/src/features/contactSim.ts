/**
 * 비상연락처 '수락' 시뮬레이션 (v3·3 · v3·4). 화면에서만 쓰고 서버·계약은 건드리지 않는다.
 *
 * 저장값이 없는 연락처는 1순위 = 수락함, 나머지 = 대기로 본다.
 * 실제 사고 대응(서버)은 수락 여부와 상관없이 1순위부터 차례로 알린다 — 수락은 화면 표시용 시뮬레이션이다.
 * v3 디자인 문구('수락한 사람만 실제 상황에서 알림을 받아요.')는 디자인 그대로 둔다.
 */
import type { ContactDto } from '@rider-guard/contract';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { BadgeTone } from '@/components/ui';
import { KEYS, storage } from '@/lib/storage';

export type Acceptance = 'accepted' | 'pending' | 'declined';

/** 배지 문구 ('✓ 수락함' · '대기' · '거절함') */
export const ACCEPTANCE_LABEL: Record<Acceptance, string> = { accepted: '수락함', pending: '대기', declined: '거절함' };
/** 요약 줄에 쓰는 짧은 말 ('1순위 김민지 수락, 2순위 박준호 대기') */
export const ACCEPTANCE_SHORT: Record<Acceptance, string> = { accepted: '수락', pending: '대기', declined: '거절' };
/** 연락처 행 아래 보조 줄 (v3·3 '수락 대기 중') */
export const ACCEPTANCE_TEXT: Record<Acceptance, string> = {
  accepted: '비상연락처 요청을 수락했어요',
  pending: '수락 대기 중',
  declined: '비상연락처 요청을 거절했어요',
};
/** 배지 색 — accepted 는 check 를 함께 (v3: 연초록 + ✓). 평소 화면이라 거절도 빨강이 아니다 */
export const ACCEPTANCE_TONE: Record<Acceptance, BadgeTone> = { accepted: 'green', pending: 'neutral', declined: 'neutral' };

type Overrides = Record<string, Acceptance>;
type Stamps = Record<string, string>;

const isAcceptance = (v: unknown): v is Acceptance => v === 'accepted' || v === 'pending' || v === 'declined';

function parse(raw: string | null | undefined): Overrides {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Overrides = {};
    for (const [id, v] of Object.entries(obj ?? {})) if (isAcceptance(v)) out[id] = v;
    return out;
  } catch {
    return {};
  }
}

function parseStamps(raw: string | null | undefined): Stamps {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Stamps = {};
    for (const [id, v] of Object.entries(obj ?? {})) if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) out[id] = v;
    return out;
  } catch {
    return {};
  }
}

const webRaw = storage.peekWeb(KEYS.contactSim);
let overrides: Overrides = parse(webRaw);
let stamps: Stamps = parseStamps(storage.peekWeb(KEYS.contactSimAt));
let ready = webRaw !== undefined;
let loadStarted = false;
let touched = false;
const listeners = new Set<() => void>();

type Snapshot = { overrides: Overrides; stamps: Stamps; ready: boolean };
let snapshot: Snapshot = { overrides, stamps, ready };

function emit() {
  snapshot = { overrides, stamps, ready };
  listeners.forEach((l) => l());
}

function load() {
  if (loadStarted || ready) return;
  loadStarted = true;
  Promise.all([storage.get(KEYS.contactSim), storage.get(KEYS.contactSimAt)])
    .then(([raw, rawAt]) => {
      // 읽는 사이 바꾼 값이 있으면 그것을 우선한다
      overrides = touched ? { ...parse(raw), ...overrides } : parse(raw);
      stamps = touched ? { ...parseStamps(rawAt), ...stamps } : parseStamps(rawAt);
      ready = true;
      emit();
    })
    .catch(() => {
      ready = true;
      emit();
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

/** 저장값이 없을 때의 수락 상태 */
export const defaultAcceptance = (priority: number): Acceptance => (priority === 1 ? 'accepted' : 'pending');

/** 연락처 하나의 수락 상태를 바꾼다 (수락 웹 시뮬레이션의 '수락할게요'·'거절하기'). 바뀐 시각도 남긴다. */
export function setAcceptance(id: string, status: Acceptance) {
  touched = true;
  overrides = { ...overrides, [id]: status };
  stamps = { ...stamps, [id]: new Date().toISOString() };
  emit();
  void storage.set(KEYS.contactSim, JSON.stringify(overrides));
  void storage.set(KEYS.contactSimAt, JSON.stringify(stamps));
}

export type ContactAcceptance = {
  statusOf: (id: string) => Acceptance;
  set: (id: string, status: Acceptance) => void;
  /** 수락 상태가 바뀐 시각(ISO). 저장값 없이 기본으로 수락인 1순위는 null */
  changedAt: (id: string) => string | null;
  summary: Record<Acceptance, number>;
  ready: boolean;
};

/**
 * 연락처들의 수락 상태. 화면 사이에 공유된다.
 * const acc = useContactAcceptance(me?.contacts); acc.statusOf(c.id) → 'accepted' | 'pending' | 'declined'
 */
export function useContactAcceptance(contacts: ContactDto[] | null | undefined): ContactAcceptance {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const list = useMemo(() => contacts ?? [], [contacts]);
  const statusOf = useCallback(
    (id: string): Acceptance => snap.overrides[id] ?? defaultAcceptance(list.find((c) => c.id === id)?.priority ?? Number.POSITIVE_INFINITY),
    [snap, list],
  );
  const changedAt = useCallback((id: string) => snap.stamps[id] ?? null, [snap]);
  const summary = useMemo(() => {
    const counts: Record<Acceptance, number> = { accepted: 0, pending: 0, declined: 0 };
    for (const c of list) counts[snap.overrides[c.id] ?? defaultAcceptance(c.priority)] += 1;
    return counts;
  }, [snap, list]);
  return { statusOf, set: setAcceptance, changedAt, summary, ready: snap.ready };
}

// ── v3 요약 문구 ──────────────────────────────────────────────

/**
 * 순위별 수락 요약 (v3·5 홈 비상연락처 카드) — '1순위 김민지 수락, 2순위 박준호 대기'.
 * 셋 이상이면 앞의 둘만 적고 ' 외 N명'. 연락처가 없으면 ''.
 */
export function acceptanceSummaryText(contacts: ContactDto[] | null | undefined, statusOf: (id: string) => Acceptance, max = 2): string {
  const list = [...(contacts ?? [])].sort((a, b) => a.priority - b.priority);
  if (!list.length) return '';
  const head = list
    .slice(0, max)
    .map((c) => `${c.priority}순위 ${c.name} ${ACCEPTANCE_SHORT[statusOf(c.id)]}`)
    .join(', ');
  return list.length > max ? `${head} 외 ${list.length - max}명` : head;
}

/** 수락한 사람 수 (v3·6 잠금화면 '비상연락처 1명 수락'). 아무도 없으면 '비상연락처 수락 대기' */
export function acceptedCountText(summary: Record<Acceptance, number>): string {
  return summary.accepted > 0 ? `비상연락처 ${summary.accepted}명 수락` : '비상연락처 수락 대기';
}
