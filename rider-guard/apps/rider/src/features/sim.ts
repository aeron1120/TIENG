/**
 * v3 시뮬레이션 도우미 — 실제로 받을 수 없는 값을 앱 안에서 그럴듯하게 채운다. 서버에는 아무것도 보내지 않는다.
 *
 *   SIM                 기본값 (헬멧 배터리 · 주소 · 위치 · 이름 · 60초 에스컬레이션 · 30초 본인 확인)
 *   useOtpSim           휴대폰 인증번호 — '인증 요청' 후 약 1.2초 뒤 6자리가 자동으로 채워진다
 *   useConsentSim       선택 동의 '오탐 구간을 정확도 개선에 제공' (로컬 저장)
 *   pending name        가입 화면의 이름 → v3·1 에서 가입 정보로 저장
 *   simAddress · wearTime · useNow · escalationCountdown
 *   useSimNotifications 종 아이콘 알림 목록 (연락처 수락 등)
 *
 * 헬멧 착용·음성은 features/helmet, 연락처 수락은 features/contactSim 이 맡는다.
 */
import type { ContactDto, MeDto } from '@rider-guard/contract';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useContactAcceptance } from '@/features/contactSim';
import { formatMobile, timeAgo } from '@/lib/format';
import { KEYS, storage } from '@/lib/storage';

// ── 기본값 ────────────────────────────────────────────────────

/** 서버 CONTACT_STAGGER_SECONDS 기본값(60초)과 같다 — 서버는 이 간격으로 다음 순위 문자를 예약한다. 센서 판정 창과 무관한 운영값. */
export const ESCALATION_STEP_S = 60;
export const SELF_CHECK_S = 30;

export const SIM = {
  /** 헬멧 배터리(%) — 실제 기기가 없을 때 */
  battery: 78,
  /** 좌표 → 주소 변환이 없어 보여 주는 주소 */
  address: '서울 강남구 테헤란로 152',
  /** 위치 기록이 없을 때 지도 가운데 (역삼역) */
  position: { lat: 37.5006, lng: 127.0364, accuracy: 25 },
  /** 라이더 이름이 없을 때 */
  riderName: '김도윤',
  /** 연락처 이름이 없을 때 (1순위, 2순위…) */
  contactNames: ['김민지', '박준호', '이서연'],
  /** 다음 순위로 넘어가기까지 (서버 기본 60초) */
  escalationStepS: ESCALATION_STEP_S,
  /** 사고 확인 화면에서 본인 응답을 기다리는 시간 (v3·8 '본인 확인 응답 없음 (30초)') */
  selfCheckS: SELF_CHECK_S,
  /** 저장값 없이 처음부터 수락인 1순위를 '몇 분 전에 수락했다'고 볼지 (v3·6 '20분 전') */
  acceptedAgoMin: 20,
  /** 인증번호가 자동으로 채워지기까지 */
  otpFillMs: 1200,
} as const;

/** 앱을 켠 시각 — '20분 전' 같은 시뮬레이션 시각의 기준 (렌더마다 흔들리지 않게 한 번만) */
const BOOT = Date.now();

/** 라이더 이름 — 실제 값이 없으면 시뮬레이션 이름 */
export const riderDisplayName = (name?: string | null) => name?.trim() || SIM.riderName;

/** 연락처 이름 — 실제 값이 없으면 순위별 시뮬레이션 이름 */
export const contactDisplayName = (name: string | null | undefined, priority = 1) =>
  name?.trim() || SIM.contactNames[(priority - 1) % SIM.contactNames.length]!;

// ── 시계 ──────────────────────────────────────────────────────

/** 매 intervalMs 마다 다시 그려지는 현재 시각(ms). enabled=false 면 멈춘다. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 착용 시간 — 1시간 미만 'mm:ss'('12:40'), 넘으면 'h:mm:ss'. 시작 시각이 없으면 '00:00' */
export function wearTime(startedAt: string | number | Date | null | undefined, now: number = Date.now()): string {
  if (startedAt == null) return '00:00';
  const start = startedAt instanceof Date ? startedAt.getTime() : typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  const s = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export type EscalationCountdown = {
  /** 지금 순위 차례에서 남은 초 (0~180) */
  remainingS: number;
  /** 지금 순위 차례에서 지난 초 */
  elapsedS: number;
  /** 남은 비율 1→0 (v3·8·9 빨간 막대 길이) */
  progress: number;
  /** 몇 번째 차례인가 — 0 = 1순위를 기다리는 중, 1 = 2순위까지 알린 뒤… (steps 를 넘지 않는다) */
  step: number;
  /** 모든 순위 차례가 끝났다 */
  done: boolean;
  /** '2:41' */
  text: string;
  /** '02:41' */
  textPadded: string;
};

/**
 * 순위별 에스컬레이션 카운트다운 — 서버 기본 간격(60초)으로 화면에서 계산한다(서버는 다음 순위까지 남은 시간을 주지 않는다).
 * stepStartedAt = 1순위에게 알린 시각(예: 대응 단계 contacts 의 at, 없으면 incident.escalatedAt).
 * steps = 순위 수(연락처 수). 마지막 차례가 끝나면 0 에 멈춘다.
 */
export function escalationCountdown(
  stepStartedAt: string | number | Date | null | undefined,
  now: number = Date.now(),
  { stepS = ESCALATION_STEP_S, steps = 1 }: { stepS?: number; steps?: number } = {},
): EscalationCountdown {
  const start =
    stepStartedAt == null
      ? now
      : stepStartedAt instanceof Date
        ? stepStartedAt.getTime()
        : typeof stepStartedAt === 'number'
          ? stepStartedAt
          : Date.parse(stepStartedAt);
  const total = Math.max(0, Math.floor(((Number.isFinite(start) ? now - start : 0) as number) / 1000));
  const lastStep = Math.max(1, steps) - 1;
  const step = Math.min(Math.floor(total / stepS), lastStep);
  const done = total >= stepS * (lastStep + 1);
  const elapsedS = done ? stepS : total - step * stepS;
  const remainingS = Math.max(0, stepS - elapsedS);
  return {
    remainingS,
    elapsedS,
    progress: remainingS / stepS,
    step,
    done,
    text: `${Math.floor(remainingS / 60)}:${pad(remainingS % 60)}`,
    textPadded: `${pad(Math.floor(remainingS / 60))}:${pad(remainingS % 60)}`,
  };
}

// ── 위치 · 주소 ───────────────────────────────────────────────

export type SimPosition = { lat: number; lng: number; accuracy: number | null; recordedAt: string | null; simulated: boolean };

/** 실제 위치가 있으면 그것을, 없으면 서울 기본 좌표(시뮬레이션)를 돌려준다. */
export function simPosition(real?: { lat: number; lng: number; accuracy?: number | null; recordedAt?: string | null } | null): SimPosition {
  if (real && Number.isFinite(real.lat) && Number.isFinite(real.lng)) {
    return { lat: real.lat, lng: real.lng, accuracy: real.accuracy ?? null, recordedAt: real.recordedAt ?? null, simulated: false };
  }
  return { ...SIM.position, recordedAt: null, simulated: true };
}

/** 주소 — 서버가 준 주소가 있으면 그것을, 없으면 시뮬레이션 주소(좌표 → 주소 변환이 없다). */
export function simAddress(location?: { address?: string | null } | null): string {
  return location?.address?.trim() || SIM.address;
}

// ── 휴대폰 인증번호 ───────────────────────────────────────────

const randomCode = () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

/** 인증번호를 '보낸다'(시뮬레이션). 약 0.6초 뒤 6자리 코드로 끝난다 — 서버로는 아무것도 가지 않는다. */
export function requestOtp(phone: string): Promise<string> {
  void phone;
  return new Promise((resolve) => setTimeout(() => resolve(randomCode()), 600));
}

export type OtpStatus = 'idle' | 'sending' | 'sent';

export type OtpSim = {
  status: OtpStatus;
  /** 입력칸 값 — 보낸 뒤 약 1.2초 지나면 자동으로 채워진다 */
  code: string;
  setCode: (v: string) => void;
  /** '인증 요청' — 다시 누르면 새 코드로 다시 보낸다 */
  request: (phone: string) => void;
  /** 받은 번호 '010-1234-5678' */
  sentTo: string | null;
  /** 입력한 6자리가 보낸 코드와 같다 */
  verified: boolean;
  reset: () => void;
};

/**
 * 휴대폰 인증 시뮬레이션 (v3·1 '인증 요청' → '인증번호 6자리').
 * const otp = useOtpSim(); <Button label="인증 요청" onPress={() => otp.request(phone)} loading={otp.status === 'sending'} />
 * <Input value={otp.code} onChangeText={otp.setCode} />  — otp.verified 면 다음으로.
 */
export function useOtpSim(): OtpSim {
  const [status, setStatus] = useState<OtpStatus>('idle');
  const [code, setCodeState] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      seq.current += 1;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const request = useCallback((phone: string) => {
    const my = ++seq.current;
    if (timer.current) clearTimeout(timer.current);
    setStatus('sending');
    setCodeState('');
    requestOtp(phone).then((next) => {
      if (my !== seq.current) return;
      setIssued(next);
      setSentTo(formatMobile(phone));
      setStatus('sent');
      // 문자로 받은 번호를 자동으로 채우는 흐름
      timer.current = setTimeout(() => {
        if (my === seq.current) setCodeState(next);
      }, SIM.otpFillMs);
    });
  }, []);

  const setCode = useCallback((v: string) => {
    if (timer.current) clearTimeout(timer.current);
    setCodeState(v.replace(/\D/g, '').slice(0, 6));
  }, []);

  const reset = useCallback(() => {
    seq.current += 1;
    if (timer.current) clearTimeout(timer.current);
    setStatus('idle');
    setCodeState('');
    setIssued(null);
    setSentTo(null);
  }, []);

  return { status, code, setCode, request, sentTo, verified: !!issued && code === issued, reset };
}

// ── 작은 저장소 (선택 동의 · 가입 이름 · 알림 읽음) ──────────────

/** 모듈 스토어 하나 — 웹은 첫 렌더부터 저장값, 네이티브는 비동기로 읽는다 */
function createStore<T>(key: string, parse: (raw: string | null | undefined) => T, serialize: (v: T) => string | null) {
  const webRaw = storage.peekWeb(key);
  let value = parse(webRaw);
  let ready = webRaw !== undefined;
  let loadStarted = false;
  let touched = false;
  let snap = { value, ready };
  const listeners = new Set<() => void>();
  const emit = () => {
    snap = { value, ready };
    listeners.forEach((l) => l());
  };
  const load = () => {
    if (loadStarted || ready) return;
    loadStarted = true;
    storage
      .get(key)
      .then((raw) => {
        if (!touched) value = parse(raw);
        ready = true;
        emit();
      })
      .catch(() => {
        ready = true;
        emit();
      });
  };
  return {
    subscribe(l: () => void) {
      listeners.add(l);
      load();
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => snap,
    get: () => value,
    async read(): Promise<T> {
      if (ready) return value;
      try {
        const raw = await storage.get(key);
        if (!touched) value = parse(raw);
      } catch {
        /* 못 읽으면 기본값 */
      }
      ready = true;
      emit();
      return value;
    },
    set(next: T) {
      touched = true;
      value = next;
      ready = true;
      emit();
      void storage.set(key, serialize(next));
    },
  };
}

// 선택 동의 — '오탐 구간을 정확도 개선에 제공'
type ConsentSim = { falsePositive: boolean };
const consentStore = createStore<ConsentSim>(
  KEYS.consentSim,
  (raw) => {
    try {
      const v = raw ? (JSON.parse(raw) as Partial<ConsentSim>) : null;
      return { falsePositive: v?.falsePositive === true };
    } catch {
      return { falsePositive: false };
    }
  },
  (v) => JSON.stringify(v),
);

/** 선택 동의(시뮬레이션) 저장 — 서버 계약에 이 항목이 없어 기기에만 남긴다 */
export const setFalsePositiveConsent = (value: boolean) => consentStore.set({ falsePositive: value });

/** [동의 여부, 바꾸기] — const [optIn, setOptIn] = useConsentSim(); */
export function useConsentSim(): [boolean, (value: boolean) => void] {
  const snap = useSyncExternalStore(consentStore.subscribe, consentStore.getSnapshot, consentStore.getSnapshot);
  return [snap.value.falsePositive, setFalsePositiveConsent];
}

// 가입 화면의 이름 — 문자열 그대로 저장한다 (하네스·웹 localStorage 와 같은 형식)
const nameStore = createStore<string | null>(
  KEYS.pendingName,
  (raw) => raw?.trim() || null,
  (v) => v?.trim() || null,
);

/** 가입 화면에서 받은 이름을 둔다 (v3·1 에서 가입 정보로 저장) */
export const setPendingName = (name: string) => nameStore.set(name.trim() || null);
/** 저장한 뒤 지운다 */
export const clearPendingName = () => nameStore.set(null);
/** 비동기로 읽기 (네이티브) — 웹은 바로 */
export const getPendingName = () => nameStore.read();
/** 동기로 지금 값 (웹은 첫 렌더부터, 네이티브는 읽기 전 null) */
export const peekPendingName = () => nameStore.get();

/** 가입 이름 { name, ready } — v3·1 이 이름 입력 없이 이 값을 쓴다 */
export function usePendingName(): { name: string | null; ready: boolean } {
  const snap = useSyncExternalStore(nameStore.subscribe, nameStore.getSnapshot, nameStore.getSnapshot);
  return { name: snap.value, ready: snap.ready };
}

// ── 알림 목록 (종 아이콘) ─────────────────────────────────────

export type SimNotification = {
  id: string;
  kind: 'contact' | 'protection' | 'pending';
  title: string;
  body: string;
  /** ISO */
  at: string;
  /** '20분 전' */
  ago: string;
  unread: boolean;
};

const seenStore = createStore<string | null>(
  KEYS.notifSeen,
  (raw) => (raw && !Number.isNaN(Date.parse(raw)) ? raw : null),
  (v) => v,
);

/** 알림 목록을 열었다 — 이 시각 이전 알림은 읽음 */
export const markNotificationsSeen = () => seenStore.set(new Date().toISOString());

/**
 * 종 아이콘 Sheet 에 보여 줄 알림(시뮬레이션). 최신순.
 * - 수락한 연락처: '비상연락처 수락' / '[이름]님이 비상연락처 요청을 수락했어요.'
 * - 보호 중(세션 있음): '보호 중' / '헬멧 연결됨, 앱을 닫아도 계속 보호돼요'
 * - 대기 중인 연락처: '수락 대기' / '[이름]님이 아직 수락하지 않았어요.'
 * const { items, unread, markSeen } = useSimNotifications(me);
 */
export function useSimNotifications(me: Pick<MeDto, 'contacts' | 'session'> | null | undefined): {
  items: SimNotification[];
  unread: number;
  markSeen: () => void;
} {
  const contacts: ContactDto[] = useMemo(() => me?.contacts ?? [], [me?.contacts]);
  const acc = useContactAcceptance(contacts);
  const seen = useSyncExternalStore(seenStore.subscribe, seenStore.getSnapshot, seenStore.getSnapshot).value;
  const now = useNow(60_000);
  const sessionStart = me?.session?.startedAt ?? null;

  const items = useMemo(() => {
    const out: Omit<SimNotification, 'ago' | 'unread'>[] = [];
    for (const c of [...contacts].sort((a, b) => a.priority - b.priority)) {
      const status = acc.statusOf(c.id);
      const name = contactDisplayName(c.name, c.priority);
      const at = acc.changedAt(c.id) ?? new Date(BOOT - (SIM.acceptedAgoMin + c.priority - 1) * 60_000).toISOString();
      if (status === 'accepted') {
        out.push({ id: `accept-${c.id}`, kind: 'contact', title: '비상연락처 수락', body: `${name}님이 비상연락처 요청을 수락했어요.`, at });
      } else if (status === 'pending') {
        out.push({ id: `pending-${c.id}`, kind: 'pending', title: '수락 대기', body: `${name}님이 아직 수락하지 않았어요.`, at });
      }
    }
    if (sessionStart) {
      out.push({ id: `protect-${sessionStart}`, kind: 'protection', title: '보호 중', body: '헬멧 연결됨, 앱을 닫아도 계속 보호돼요', at: sessionStart });
    }
    return out
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((n) => ({ ...n, ago: timeAgo(n.at, now), unread: !seen || Date.parse(n.at) > Date.parse(seen) }));
  }, [contacts, acc, sessionStart, now, seen]);

  return { items, unread: items.filter((n) => n.unread).length, markSeen: markNotificationsSeen };
}
