/**
 * 헬멧 시뮬레이션 (v3·2 '헬멧을 쓰면 보호가 자동으로 켜져요').
 *
 * 실제 헬멧 연동은 아직 없다. 착용 여부와 '말로 응답하기'를 앱이 흉내 내고, 저장소에 남겨 다시 켜도 이어진다.
 * 착용 = 보호 켜짐 = 서버 운행 세션. 전환은 SessionServices 안의 useAutoProtection 이 맡는다 — 화면에는 운행 시작/종료 버튼이 없다.
 * 사고 감지·판정은 여기서 하지 않는다 (다른 팀 몫).
 */
import type { DeviceDto } from '@rider-guard/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { keys, useEndSession, useMe, useStartSession } from '@/api/hooks';
import { SIM } from '@/features/sim';
import { batteryText } from '@/lib/format';
import { KEYS, storage } from '@/lib/storage';

// ── 착용 · 음성 상태 (모듈 스토어 — 여러 화면이 같은 값을 본다) ─────────

export type HelmetSim = { worn: boolean; voice: boolean };
/** 보호를 켜거나(start) 끄는(end) 요청이 진행 중인가 */
export type ProtectionPending = 'start' | 'end' | null;

const DEFAULT_SIM: HelmetSim = { worn: true, voice: true };

type HelmetState = HelmetSim & {
  /** 저장된 값을 읽었는가. 네이티브는 첫 렌더 직후 잠깐 false */
  ready: boolean;
  protectionPending: ProtectionPending;
  /** 마지막 자동 보호 전환 실패. 성공하거나 목표 상태에 닿으면 비운다 */
  protectionError: unknown;
  /** 헬멧을 벗었지만 사고 대응이 진행 중이라 보호를 켜 둔 상태 */
  heldByIncident: boolean;
};

function parseSim(raw: string | null | undefined): HelmetSim {
  if (!raw) return DEFAULT_SIM;
  try {
    const v = JSON.parse(raw) as Partial<HelmetSim>;
    return {
      worn: typeof v.worn === 'boolean' ? v.worn : DEFAULT_SIM.worn,
      voice: typeof v.voice === 'boolean' ? v.voice : DEFAULT_SIM.voice,
    };
  } catch {
    return DEFAULT_SIM;
  }
}

// 웹은 첫 렌더부터 저장값으로 — 기본값(착용)으로 그렸다가 바뀌며 보호가 잠깐 켜지는 일이 없게
const webRaw = storage.peekWeb(KEYS.helmetSim);
let state: HelmetState = {
  ...parseSim(webRaw),
  ready: webRaw !== undefined,
  protectionPending: null,
  protectionError: null,
  heldByIncident: false,
};
const listeners = new Set<() => void>();
let touched = false;
let loadStarted = false;

function emit(patch: Partial<HelmetState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function load() {
  if (loadStarted || state.ready) return;
  loadStarted = true;
  storage
    .get(KEYS.helmetSim)
    // 읽는 사이 사용자가 이미 바꿨으면 그 값을 둔다
    .then((raw) => emit(touched ? { ready: true } : { ...parseSim(raw), ready: true }))
    .catch(() => emit({ ready: true }));
}

function persist() {
  void storage.set(KEYS.helmetSim, JSON.stringify({ worn: state.worn, voice: state.voice } satisfies HelmetSim));
}

/** 헬멧을 쓰고 벗기 (시뮬레이션). 보호 전환은 자동으로 따라온다. */
export function setHelmetWorn(worn: boolean) {
  touched = true;
  emit({ worn });
  persist();
}

/** '말로 응답하기' (시뮬레이션 — 실제 음성 인식은 없다) */
export function setHelmetVoice(voice: boolean) {
  touched = true;
  emit({ voice });
  persist();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => {
    listeners.delete(listener);
  };
}

const getState = () => state;

export type HelmetApi = HelmetSim & {
  ready: boolean;
  setWorn: (worn: boolean) => void;
  setVoice: (voice: boolean) => void;
  protectionPending: ProtectionPending;
  protectionError: unknown;
  heldByIncident: boolean;
};

/** 헬멧 착용·음성 응답 시뮬레이션 상태. 어느 화면에서 바꿔도 모든 화면이 같은 값을 본다. */
export function useHelmet(): HelmetApi {
  const s = useSyncExternalStore(subscribe, getState, getState);
  return {
    worn: s.worn,
    voice: s.voice,
    ready: s.ready,
    setWorn: setHelmetWorn,
    setVoice: setHelmetVoice,
    protectionPending: s.protectionPending,
    protectionError: s.protectionError,
    heldByIncident: s.heldByIncident,
  };
}

// ── 헬멧 표시 정보 ────────────────────────────────────────────

export type HelmetInfo = {
  /** 늘 '헬멧 모듈' (디자인 문구) — 실제 기기 종류는 detail 에 */
  name: string;
  /** '개발용 웹캠 detector' · '헬멧 태그' */
  detail: string;
  connected: boolean;
  battery: number | null;
  /** 실제 페어링된 기기가 없어 가상 헬멧을 보여 주는 중 (v3 디자인 화면에는 표시를 붙이지 않는다) */
  simulated: boolean;
};

const HELMET_NAME = '헬멧 모듈';
const VIRTUAL_HELMET: HelmetInfo = { name: HELMET_NAME, detail: '개발용 웹캠 detector', connected: true, battery: SIM.battery, simulated: true };

/**
 * 헬멧 모듈 표시 정보. 헬멧 연결·배터리는 시뮬레이션이라 페어링된 기기(me.device)가 없으면 가상 헬멧을 보여 준다.
 * 기기가 있으면 종류·배터리는 그 값을 쓰고, 연결은 기기 신호와 착용(시뮬레이션)을 합친다 — 쓰고 있으면(보호 중) 연결됨.
 * worn = useHelmet().worn (잠금화면 상시 알림처럼 보호 중에만 보이는 곳은 true)
 */
export function helmetInfo(device: DeviceDto | null | undefined, worn: boolean): HelmetInfo {
  if (!device) return VIRTUAL_HELMET;
  return {
    name: HELMET_NAME,
    detail: device.kind === 'webcam' ? '개발용 웹캠 detector' : '헬멧 태그',
    connected: device.connected || worn,
    battery: device.battery ?? SIM.battery,
    simulated: false,
  };
}

/** v3·2 카드 제목 — '헬멧 모듈 연결됨' / '헬멧 모듈 연결 끊김' */
export const helmetTitle = (info: HelmetInfo) => `${info.name} ${info.connected ? '연결됨' : '연결 끊김'}`;

/** v3·2 카드 보조 줄 — '개발용 웹캠 detector, 배터리 78%' */
export const helmetLine = (info: HelmetInfo) => `${info.detail}, 배터리 ${batteryText(info.battery)}`;

/** v3·5 홈 '헬멧' 칸 — '연결됨 78%' / '끊김' */
export const helmetStatusText = (info: HelmetInfo) => (info.connected ? `연결됨 ${batteryText(info.battery)}` : '끊김');

// ── 보호 상태 (화면용) ────────────────────────────────────────

export type ProtectionState = {
  /** 서버 운행 세션이 있다 = 보호 중 */
  active: boolean;
  /** '헬멧 착용 HH:MM부터'의 기준 (me.session.startedAt) */
  startedAt: string | null;
  worn: boolean;
  pending: ProtectionPending;
  error: unknown;
  heldByIncident: boolean;
  /** me 와 저장된 착용 상태를 모두 읽었는가 */
  ready: boolean;
};

/** 보호 중인지, 언제부터인지, 켜는 중인지. 켜고 끄는 일은 useAutoProtection 이 한다. */
export function useProtection(): ProtectionState {
  const { data: me } = useMe();
  const h = useHelmet();
  return {
    active: !!me?.session,
    startedAt: me?.session?.startedAt ?? null,
    worn: h.worn,
    pending: h.protectionPending,
    error: h.protectionError,
    heldByIncident: h.heldByIncident,
    ready: h.ready && !!me,
  };
}

// ── 자동 보호 (SessionServices 안에서 한 번만 돌린다) ─────────────

/** 실패한 전환은 이만큼 지난 뒤에만 다시 시도한다 — 서버가 계속 거절할 때 요청을 쏟아내지 않게 */
const RETRY_MS = 60_000;

/**
 * 헬멧을 쓰면 보호(운행 세션)를 켜고, 벗으면 끈다.
 * - 가입 정보(이름·휴대폰·필수 동의)를 마치기 전에는 켜지 않는다 (서버도 403).
 * - 같은 목표로는 한 번만 요청하고, 실패하면 60초 뒤에만 다시 — 무한 재시도·깜빡임 없이.
 * - 사고 대응이 진행 중이면 헬멧을 벗어도 끄지 않는다 — 대응 중 위치 수집이 끊기지 않게. 끝나면 끈다.
 *   incidentOpen 이 null(진행 중 사고를 아직 못 받아 봄)이어도 끄지 않고 기다린다.
 */
export function useAutoProtection(incidentOpen: boolean | null) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { worn, ready } = useHelmet();
  const { mutate: startSession, isPending: starting } = useStartSession();
  const { mutate: endSession, isPending: ending } = useEndSession();
  const attempt = useRef<{ target: 'start' | 'end'; at: number } | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const active = !!me?.session;
  const held = !worn && active && incidentOpen === true;
  const target: ProtectionPending = !me || !ready ? null : worn ? (me.onboarded && !active ? 'start' : null) : active && incidentOpen === false ? 'end' : null;

  useEffect(() => {
    if (state.heldByIncident !== held) emit({ heldByIncident: held });
  }, [held]);

  useEffect(() => {
    if (!target) {
      // 목표 상태에 닿았다 — 다음 변화(헬멧 쓰기·벗기)에는 바로 다시 시도할 수 있게
      attempt.current = null;
      if (!starting && !ending && (state.protectionPending || state.protectionError)) emit({ protectionPending: null, protectionError: null });
      return;
    }
    if (starting || ending) return;
    const prev = attempt.current;
    if (prev?.target === target) {
      const wait = prev.at + RETRY_MS - Date.now();
      if (wait > 0) {
        const timer = setTimeout(() => setRetryTick((n) => n + 1), wait);
        return () => clearTimeout(timer);
      }
    }
    attempt.current = { target, at: Date.now() };
    emit({ protectionPending: target, protectionError: null });
    const run = target === 'start' ? startSession : endSession;
    run(undefined, {
      onSuccess: () => emit({ protectionPending: null, protectionError: null }),
      onError: (error) => {
        emit({ protectionPending: null, protectionError: error });
        // 이미 켜져 있거나 꺼져 있었을 수 있다 — 서버 상태를 다시 받아 목표와 비교한다
        void qc.invalidateQueries({ queryKey: keys.me });
      },
    });
  }, [target, retryTick, starting, ending, startSession, endSession, qc]);
}
