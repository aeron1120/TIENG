/**
 * 통합 시연의 세계 — 라이더 1명의 보호·사고 확인, 대행사 관제, 주문 처리가 같은 사건·같은 시계를 쓴다.
 * React Native 를 가져오지 않는 순수 함수라 node --test 로 검증한다.
 *
 * 센서 판정은 서버(/demo-api, 운영과 같은 imu-report-v1)가 ESP32 실측 파형에 대해 낸 결과(candidateAt)를 받아 쓴다.
 * 라이더·주문·관제 흐름과 위치는 시연 데이터다 — 실제로 아무에게도 연락하지 않는다.
 *
 * 시간
 *   t            시연 시계(초). 0 부터 정상 주행(LEAD_IN_S), 이어서 사건 파형 구간, 그 뒤는 사건 이후.
 *   clip 시각    파형 원본의 센서 시각. 사건 구간에서 clipT = from + (t - LEAD_IN_S).
 *   사건 구간은 느리게(SLOWMO) 재생할 수 있다 — 1.5초 파형을 눈으로 따라가게. 응답 대기 30초는 운영 설정값이고
 *   센서 판정 지연(파형 안의 시각)과 별개다.
 */

export type ScenarioId = 'full' | 'normal' | 'curb' | 'stopped' | 'gap';
export type CaseId = string;

export const SCENARIOS: Record<ScenarioId, { title: string; caseId: CaseId; short: string; point: string }> = {
  full: { title: '정상 주행 → A1 충돌', caseId: 'A1', short: 'A1 충돌', point: '감지부터 관제 접수·대체 배차·사건 보고서까지 한 번에' },
  normal: { title: '정상 주행 → D7 요철 노면', caseId: 'D7', short: 'D7 정상 주행', point: '사고 후보가 없는 정상 주행 — 연락·주문 보류 없이 감시를 이어가요' },
  curb: { title: '정상 주행 → D6 연석 오르내리기', caseId: 'D6', short: 'D6 연석', point: '정상으로 분류된 실험도 판정창에 누락이 있으면 데이터 부족을 따로 표시해요' },
  stopped: { title: '정상 주행 → B3 정지 중 후방 피추돌', caseId: 'B3', short: 'B3 정지 중 피추돌', point: '멈춰 있었고 차체가 넘어지지 않았어도 충격+회전으로 감지' },
  gap: { title: '정상 주행 → C3 충격 구간 누락', caseId: 'C3', short: 'C3 누락 구간', point: '패킷이 빠진 구간 — "사고 후보 감지 / ΔV 계산 불가"를 함께 표시' },
};
export const SCENARIO_IDS = Object.keys(SCENARIOS) as ScenarioId[];

/** 앞부분 정상 주행 파형 (D7 요철 노면 연속 주행 — 판정창 안 누락 없음, 후보 없음) */
export const LEAD_CASE = 'D7';
export const LEAD_IN_S = 6;
export const SLOWMO = 0.2;
/** 본인 응답 대기 — 서버 COUNTDOWN_SECONDS 와 같은 운영 설정값 */
export const RESPONSE_WAIT_S = 30;
/** 시연에서 '센서 연결 확인 필요'로 바꾸는 시간 (운영은 SENSOR_STALE_SECONDS 60초) */
export const DEMO_STALE_S = 5;

export type EventClip = { from: number; to: number; candidateAt: number | null; caseId: CaseId; decision?: 'candidate' | 'no_candidate' | 'insufficient' };

export type Actor = 'system' | 'sensor' | 'rider' | 'control' | 'order';
export type LogEntry = { t: number; actor: Actor; text: string };

export type IncidentStatus = 'confirming' | 'rider_ok' | 'escalated' | 'acknowledged' | 'resolved';
export type Incident = {
  id: string;
  caseId: CaseId;
  /** 시연 시계로 후보가 선 시각 */
  detectedT: number;
  /** 파형 원본 센서 시각으로 후보가 선 시각 */
  candidateClipT: number;
  status: IncidentStatus;
  response: 'ok' | 'help' | 'timeout' | null;
  respondedT: number | null;
  escalatedT: number | null;
  assignee: string | null;
  ackT: number | null;
  calls: { t: number; result: string }[];
  contactNotifiedT: number | null;
  resolvedT: number | null;
};

export type RiderBase = 'delivering' | 'idle' | 'off';
export type DemoRider = { id: string; name: string; base: RiderBase; lat: number; lng: number; area: string };
export type OrderStatus = 'delivering' | 'held' | 'reassigned' | 'delivered';
export type Notice = { t: number; to: '가게' | '고객' | '라이더'; text: string };
export type DemoOrder = {
  id: string;
  store: string;
  customer: string;
  riderId: string;
  originalRiderId: string;
  status: OrderStatus;
  holdReason: string | null;
  notices: Notice[];
};

export type DemoState = {
  /** 바뀔 때마다 1씩 — 여러 탭 사이에서 새 상태를 고른다 */
  v: number;
  /** 시계를 돌리는 탭 */
  driver: string | null;
  scenario: ScenarioId;
  playing: boolean;
  /** 발표용 자동 조작. 실제 발송 또는 외부 배차를 수행하지 않는다. */
  autoPilot: boolean;
  t: number;
  slowmo: boolean;
  /** 시연 시작 벽시계(ms) — 화면에 보이는 시각 = baseWall + t */
  baseWall: number;
  sensorLost: boolean;
  lastSensorT: number;
  incident: Incident | null;
  /** 이번 재생에서 사건 구간을 지났는지 (후보가 없었던 정상 사례 표시용) */
  clipDone: boolean;
  riders: DemoRider[];
  orders: DemoOrder[];
  log: LogEntry[];
};

export const MAIN_RIDER = 'r1';
export const CONTROLLER = '관제 박지훈';
export const FIRST_CONTACT = '김민지 (1순위, 가족)';

const RIDERS: DemoRider[] = [
  { id: 'r1', name: '김도윤', base: 'delivering', lat: 37.5006, lng: 127.0364, area: '역삼동 테헤란로' },
  { id: 'r2', name: '이서준', base: 'idle', lat: 37.5032, lng: 127.0412, area: '역삼동 언주로' },
  { id: 'r3', name: '박하은', base: 'delivering', lat: 37.4979, lng: 127.0276, area: '강남역 사거리' },
  { id: 'r4', name: '최민재', base: 'idle', lat: 37.5047, lng: 127.0331, area: '역삼초 앞' },
  { id: 'r5', name: '정유나', base: 'delivering', lat: 37.4991, lng: 127.0447, area: '선릉로' },
  { id: 'r6', name: '한지우', base: 'off', lat: 37.5021, lng: 127.0258, area: '휴식 중' },
];

const ORDERS = (): DemoOrder[] => [
  { id: 'BT-2041', store: '역삼 김밥천국', customer: '테헤란로 152 (12층)', riderId: 'r1', originalRiderId: 'r1', status: 'delivering', holdReason: null, notices: [] },
  { id: 'BT-2043', store: '스타벅스 역삼점', customer: '논현로 508', riderId: 'r1', originalRiderId: 'r1', status: 'delivering', holdReason: null, notices: [] },
  { id: 'BT-2038', store: '본죽 강남점', customer: '강남대로 390', riderId: 'r3', originalRiderId: 'r3', status: 'delivering', holdReason: null, notices: [] },
  { id: 'BT-2039', store: '교촌치킨 선릉점', customer: '선릉로 433', riderId: 'r5', originalRiderId: 'r5', status: 'delivering', holdReason: null, notices: [] },
];

export function initialState(scenario: ScenarioId = 'full', baseWall = Date.now(), v = 0): DemoState {
  return {
    v,
    driver: null,
    scenario,
    playing: false,
    autoPilot: false,
    t: 0,
    slowmo: true,
    baseWall,
    sensorLost: false,
    lastSensorT: 0,
    incident: null,
    clipDone: false,
    riders: RIDERS.map((r) => ({ ...r })),
    orders: ORDERS(),
    log: [{ t: 0, actor: 'system', text: `${RIDERS[0]!.name} 라이더 보호 시작 · 헬멧 센서 연결 · 비상연락처 1순위 수락` }],
  };
}

// ── 시간 ──────────────────────────────────────────────────────

export const clipLength = (clip: EventClip) => clip.to - clip.from;
export const inClip = (t: number, clip: EventClip) => t >= LEAD_IN_S && t < LEAD_IN_S + clipLength(clip);
/** 사건 파형의 후보 시각을 시연 시계로 */
export const candidateDemoT = (clip: EventClip) => (clip.candidateAt === null ? null : LEAD_IN_S + (clip.candidateAt - clip.from));
/** 시연 시계 → 파형 원본 센서 시각 (사건 구간 밖이면 null) */
export const clipTimeAt = (t: number, clip: EventClip) => (inClip(t, clip) ? clip.from + (t - LEAD_IN_S) : null);

/** 응답 대기 남은 시간(초) */
export function waitLeft(s: DemoState): number | null {
  const i = s.incident;
  if (!i || i.status !== 'confirming') return null;
  return Math.max(0, RESPONSE_WAIT_S - (s.t - i.detectedT));
}

// ── 파생 상태 ────────────────────────────────────────────────

export type RiderStatus = 'delivering' | 'idle' | 'off' | 'check' | 'incident';
export const RIDER_STATUS_LABEL: Record<RiderStatus, string> = {
  delivering: '배달 중',
  idle: '대기',
  off: '휴식',
  check: '확인 필요',
  incident: '사고 대응 중',
};

export const sensorStale = (s: DemoState) => s.sensorLost && s.t - s.lastSensorT >= DEMO_STALE_S;

export function riderStatus(s: DemoState, r: DemoRider): RiderStatus {
  if (r.id === MAIN_RIDER) {
    const st = s.incident?.status;
    if (st === 'escalated' || st === 'acknowledged') return 'incident';
    if (st === 'confirming' || sensorStale(s)) return 'check';
  }
  if (r.base === 'off') return 'off';
  // 진행 주문이 있으면 배달 중 — 대체 배차를 받은 라이더는 배달 중이 되고, 주문을 넘긴 사고 라이더는 대기가 된다
  return s.orders.some((o) => o.riderId === r.id && (o.status === 'delivering' || o.status === 'reassigned')) ? 'delivering' : 'idle';
}

export const activeOrders = (s: DemoState, riderId: string) => s.orders.filter((o) => o.riderId === riderId && o.status !== 'delivered');

/** 대체 배차 후보 — 휴식이 아니고 사고 라이더가 아닌 사람, 진행 주문이 적은 순 */
export function replacementCandidates(s: DemoState): DemoRider[] {
  return s.riders
    .filter((r) => r.id !== MAIN_RIDER && r.base !== 'off')
    .sort((a, b) => activeOrders(s, a.id).length - activeOrders(s, b.id).length);
}

// ── 동작 ──────────────────────────────────────────────────────

export type DemoAction =
  | { type: 'autopilot'; on: boolean }
  | { type: 'play'; driver: string }
  | { type: 'pause' }
  | { type: 'reset'; scenario?: ScenarioId; baseWall: number }
  | { type: 'tick'; dt: number; clip: EventClip }
  | { type: 'slowmo'; on: boolean }
  | { type: 'sensor'; lost: boolean }
  | { type: 'respond'; response: 'ok' | 'help' }
  | { type: 'skipWait' }
  | { type: 'ack' }
  | { type: 'call' }
  | { type: 'reassign'; orderId: string; riderId: string }
  | { type: 'resolve' };

const nameOf = (s: DemoState, id: string) => s.riders.find((r) => r.id === id)?.name ?? id;

function log(s: DemoState, actor: Actor, text: string, t = s.t): DemoState {
  return { ...s, log: [...s.log, { t, actor, text }] };
}

function escalate(s: DemoState, reason: 'help' | 'timeout'): DemoState {
  const i = s.incident!;
  const t = s.t;
  let next: DemoState = {
    ...s,
    incident: { ...i, status: 'escalated', response: reason, respondedT: reason === 'help' ? t : i.respondedT, escalatedT: t, contactNotifiedT: t },
  };
  next = log(next, reason === 'help' ? 'rider' : 'system', reason === 'help' ? '라이더가 "도움이 필요해요"를 눌렀어요' : `${RESPONSE_WAIT_S}초 동안 본인 응답이 없었어요`);
  next = log(next, 'system', '관제에 사건 접수 · 비상연락처 1순위에 위치 공유 (시연 — 실제 발송 없음)');
  next = log(next, 'system', '119 신고문 생성·신고 처리 시연 — 실제 신고 없음');
  // 사고 라이더의 진행 주문은 바로 보류 — 가게·고객이 기다리지 않게 관제가 대체 배차를 정한다
  const held = next.orders.filter((o) => o.riderId === MAIN_RIDER && o.status === 'delivering');
  next = {
    ...next,
    orders: next.orders.map((o) =>
      o.riderId === MAIN_RIDER && o.status === 'delivering'
        ? { ...o, status: 'held', holdReason: '라이더 사고 대응', notices: [...o.notices, { t, to: '가게', text: '배달이 잠시 지연돼요 — 대체 라이더를 배정하고 있어요' }] }
        : o,
    ),
  };
  if (held.length) next = log(next, 'order', `진행 주문 ${held.length}건 보류 (${held.map((o) => o.id).join(', ')}) · 가게에 지연 안내`);
  return next;
}

function tick(s: DemoState, dt: number, clip: EventClip): DemoState {
  if (!s.playing || dt <= 0) return s;
  const rate = s.slowmo && inClip(s.t, clip) ? SLOWMO : 1;
  const t = s.t + dt * rate;
  let next: DemoState = { ...s, t, lastSensorT: s.sensorLost ? s.lastSensorT : t };


  // 센서가 끊긴 채로 사건 구간을 지나면 판정할 파형이 없다 — 감지하지 못한 것을 그대로 남긴다
  const cT = candidateDemoT(clip);
  const clipEnd = LEAD_IN_S + clipLength(clip);
  if (!next.incident && cT !== null && s.t < cT && t >= cT) {
    if (s.sensorLost) next = log(next, 'sensor', '센서가 끊긴 동안이라 이 구간은 판정하지 못했어요', cT);
    else {
      next = {
        ...next,
        incident: {
          id: `INC-${clip.caseId}-${Math.round(s.baseWall / 1000) % 100000}`,
          caseId: clip.caseId,
          detectedT: cT,
          candidateClipT: clip.candidateAt!,
          status: 'confirming',
          response: null,
          respondedT: null,
          escalatedT: null,
          assignee: null,
          ackT: null,
          calls: [],
          contactNotifiedT: null,
          resolvedT: null,
        },
      };
      next = log(next, 'sensor', `사고 후보 감지 — 수신 데이터의 판정 근거 확인 (원본 ${clip.candidateAt!.toFixed(3)}초)`, cT);
      next = log(next, 'rider', `라이더에게 확인 요청 "사고가 의심돼요. 괜찮으신가요?" — 응답 대기 ${RESPONSE_WAIT_S}초`, cT);
    }
  }
  if (!s.clipDone && t >= clipEnd) {
    next = { ...next, clipDone: true };
    if (cT === null) next = log(next, 'sensor', clip.decision === 'insufficient' ? '사건 구간 판정 불가 — 판정창 데이터가 부족해 후보 여부를 확인하지 못했어요' : '사건 구간 판정 끝 — 수신 판정은 후보 아님, 감시 계속', clipEnd);
  }
  if (next.incident?.status === 'confirming' && t - next.incident.detectedT >= RESPONSE_WAIT_S) next = escalate(next, 'timeout');
  if (next.autoPilot) next = autoAdvance(next, clipEnd);
  return next;
}

/** 실제 서비스 호출 없이 발표 조작을 순서대로 수행한다. 수동 응답이 항상 우선한다. */
function autoAdvance(s: DemoState, clipEnd: number): DemoState {
  const i = s.incident;
  if (!i) return s.clipDone && s.t >= clipEnd + 3 ? { ...s, playing: false } : s;
  if (i.status === 'rider_ok') return s.t >= (i.respondedT ?? s.t) + 2 ? { ...s, playing: false } : s;
  if (i.status === 'resolved') return { ...s, playing: false };
  if (i.escalatedT === null) return s;
  const elapsed = s.t - i.escalatedT;
  let next = s;
  if (elapsed >= 2 && next.incident?.status === 'escalated') next = apply(next, { type: 'ack' });
  if (elapsed >= 3 && !next.incident!.calls.length) next = apply(next, { type: 'call' });
  const original = next.orders.filter((o) => o.originalRiderId === MAIN_RIDER);
  for (let index = 0; index < original.length; index++) {
    const order = original[index]!;
    const rider = replacementCandidates(next)[0];
    if (rider && order.status === 'held' && elapsed >= 4 + index * 2) next = apply(next, { type: 'reassign', orderId: order.id, riderId: rider.id });
  }
  if (elapsed >= 8 && !next.orders.some((o) => o.status === 'held')) {
    next = apply(next, { type: 'resolve' });
    next = { ...next, playing: false };
  }
  return next;
}

/** 상태 전이. 모르는 동작이나 지금 할 수 없는 동작은 그대로 둔다 (같은 버튼을 두 탭에서 눌러도 한 번만) */
export function reduce(s: DemoState, a: DemoAction): DemoState {
  const next = apply(s, a);
  return next === s ? s : { ...next, v: s.v + 1 };
}

function apply(s: DemoState, a: DemoAction): DemoState {
  const i = s.incident;
  switch (a.type) {
    case 'autopilot':
      return s.autoPilot === a.on ? s : { ...s, autoPilot: a.on };
    case 'play':
      return s.playing && s.driver === a.driver ? s : { ...s, playing: true, driver: a.driver };
    case 'pause':
      return s.playing ? { ...s, playing: false } : s;
    case 'reset':
      return initialState(a.scenario ?? s.scenario, a.baseWall, s.v);
    case 'tick':
      return tick(s, a.dt, a.clip);
    case 'slowmo':
      return s.slowmo === a.on ? s : { ...s, slowmo: a.on };
    case 'sensor':
      if (s.sensorLost === a.lost) return s;
      return log({ ...s, sensorLost: a.lost, lastSensorT: s.t }, 'sensor', a.lost ? '헬멧 센서 신호 끊김 (시연 조작)' : '헬멧 센서 신호 다시 받음');
    case 'respond':
      if (!i || i.status !== 'confirming') return s;
      if (a.response === 'help') return escalate(s, 'help');
      return log(
        { ...s, incident: { ...i, status: 'rider_ok', response: 'ok', respondedT: s.t } },
        'rider',
        '라이더가 "괜찮아요"를 눌렀어요 — 확인 결과를 기록하고 감시로 복귀 (실제 사고 아님으로 확정하지 않음)',
      );
    case 'skipWait':
      return i?.status === 'confirming' ? escalate({ ...s, t: Math.max(s.t, i.detectedT + RESPONSE_WAIT_S) }, 'timeout') : s;
    case 'ack':
      if (!i || i.status !== 'escalated') return s;
      return log({ ...s, incident: { ...i, status: 'acknowledged', assignee: CONTROLLER, ackT: s.t } }, 'control', `${CONTROLLER} 사건 접수 · 담당 지정 — 라이더 화면에 "관제사가 확인했어요" 표시`);
    case 'call': {
      if (!i || (i.status !== 'escalated' && i.status !== 'acknowledged')) return s;
      const result = i.response === 'help' ? '연결됨 — 라이더 의식 있음, 이동 불가 (시연)' : '받지 않음 (시연)';
      return log({ ...s, incident: { ...i, calls: [...i.calls, { t: s.t, result }] } }, 'control', `라이더에게 전화 — ${result}`);
    }
    case 'reassign': {
      const o = s.orders.find((x) => x.id === a.orderId);
      if (!o || o.status !== 'held' || !replacementCandidates(s).some((r) => r.id === a.riderId)) return s;
      const to = nameOf(s, a.riderId);
      const notices: Notice[] = [
        { t: s.t, to: '라이더', text: `${to} 라이더에게 배차 — ${o.store} → ${o.customer}` },
        { t: s.t, to: '가게', text: `대체 라이더 ${to} 배정 — 픽업 예정 안내` },
        { t: s.t, to: '고객', text: '라이더 사정으로 배달 라이더가 바뀌었어요 — 도착 예정 시간 다시 안내' },
      ];
      return log(
        { ...s, orders: s.orders.map((x) => (x.id === o.id ? { ...x, riderId: a.riderId, status: 'reassigned', notices: [...x.notices, ...notices] } : x)) },
        'order',
        `${o.id} 대체 배차 ${nameOf(s, o.originalRiderId)} → ${to} · 가게·고객 안내 발송 (시연)`,
      );
    }
    case 'resolve':
      if (!i || (i.status !== 'acknowledged' && i.status !== 'escalated')) return s;
      return log({ ...s, incident: { ...i, status: 'resolved', resolvedT: s.t, assignee: i.assignee ?? CONTROLLER } }, 'control', '대응 완료 — 사건 종결, 사건 보고서 생성');
  }
}

// ── 보고서 ────────────────────────────────────────────────────

export const clockAt = (s: DemoState, t: number) => {
  const d = new Date(s.baseWall + t * 1000);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  confirming: '라이더 확인 중',
  rider_ok: '라이더 괜찮음 — 감시 복귀',
  escalated: '관제 접수 대기',
  acknowledged: '관제 대응 중',
  resolved: '종결',
};

export const RESPONSE_LABEL = { ok: '괜찮아요', help: '도움이 필요해요', timeout: `무응답 (${RESPONSE_WAIT_S}초)` } as const;
