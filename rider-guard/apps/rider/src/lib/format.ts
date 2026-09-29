import type { EmergencyDelivery, IncidentDetailDto, IncidentStep, IncidentSummaryDto, OrderStatus, Relation, ShareLevel } from '@rider-guard/contract';

const pad = (n: number) => String(n).padStart(2, '0');

// ── 시각 · 시간 ────────────────────────────────────────────────

/** 'HH:MM:SS' (대응 단계 시각) */
export function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'HH:MM' — '헬멧 착용 21:02부터' */
export function hm(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(iso: string, withYear = true): string {
  const d = new Date(iso);
  const date = `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}.${date}` : date;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '9월 29일 화요일' (잠금화면 v3·6 · 홈 머리글) */
export function dayLabel(date: Date = new Date()): string {
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()]}요일`;
}

/** 'HH:MM:SS' */
export function duration(seconds: number): string {
  return durationParts(seconds).join(':');
}

/** 시·분·초를 두 자리씩 — ['02', '14', '08'] (칸마다 따로 그릴 때) */
export function durationParts(seconds: number): [string, string, string] {
  const s = Math.max(0, Math.floor(seconds));
  return [pad(Math.floor(s / 3600)), pad(Math.floor((s % 3600) / 60)), pad(s % 60)];
}

/** 지난 시간 — 1시간 미만 'm:ss'(2:41), 이상 'h:mm:ss'. 음수는 0 */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** 배터리 '78%', 모르면 '-' */
export const batteryText = (battery: number | null | undefined) => (battery == null ? '-' : `${Math.round(battery)}%`);

type TimeInput = Date | number | string | null | undefined;
const toDate = (t: TimeInput): Date | null => (t == null || t === '' ? null : t instanceof Date ? t : new Date(t));

/** 'HH:MM' — Date·ms·ISO 아무거나 (잠금화면 '21:14', '21:42 마지막 위치') */
export function timeHM(t: TimeInput = new Date()): string {
  const d = toDate(t);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

/** 'HH:MM:SS' — Date·ms·ISO 아무거나 (대응 타임라인 '21:42:05') */
export function timeHMS(t: TimeInput = new Date()): string {
  const d = toDate(t);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '';
}

/** 초 → 'm:ss' ('2:41' — v3·8 대응 단계 카드). 음수는 0 */
export function mss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** 초 → 'mm:ss' ('02:41' — v3·9 긴급 알림 웹). 음수는 0 */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** 지난 시간 — '방금' · 'N분 전' · 'N시간 전' · 'N일 전' (알림 목록 · 잠금화면 '20분 전') */
export function timeAgo(t: TimeInput, now: number = Date.now()): string {
  const d = toDate(t);
  if (!d) return '';
  const min = Math.floor((now - d.getTime()) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// ── 휴대폰 번호 ────────────────────────────────────────────────

/**
 * 휴대폰 번호를 입력하는 대로 010-1234-5678 꼴로. 서버는 숫자만 저장한다.
 * 010 은 앞에서부터 3-4-4 로 채운다 — 입력하는 동안 하이픈이 움직이지 않게.
 */
export function formatMobile(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.startsWith('010')) return [d.slice(0, 3), d.slice(3, 7), d.slice(7)].filter(Boolean).join('-');
  if (d.length < 4) return d;
  if (d.length < 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, -4)}-${d.slice(-4)}`;
}

/** 서버(normalizeMobile)와 같은 기준 */
export const isMobile = (value: string) => /^01[016789]\d{7,8}$/.test(value.replace(/\D/g, ''));

// ── 연락처 ─────────────────────────────────────────────────────

export const RELATION_LABEL: Record<Relation, string> = { family: '가족', coworker: '동료 라이더', other: '지인' };

/**
 * 위치 공개 범위 (설계문서 4.1.2). 값은 계약 그대로 두고 문구만 v2 용어로.
 * on_incident 는 관제사 '확정'이 없으니 '비상연락 시' — 도움 요청·무응답으로 비상연락이 시작된 뒤.
 */
export const SHARE_LEVELS: { value: ShareLevel; label: string; hint: string }[] = [
  { value: 'realtime', label: '보호 중 항상', hint: '헬멧을 쓰고 보호 중일 때는 실시간 위치를 볼 수 있어요.' },
  { value: 'on_anomaly', label: '사고 감지 시', hint: '사고가 감지된 순간부터 위치를 볼 수 있어요.' },
  { value: 'on_incident', label: '비상연락 시', hint: '도움을 요청하거나 응답이 없어 비상연락이 시작된 뒤에만 볼 수 있어요.' },
];

export const SHARE_LEVEL_LABEL = Object.fromEntries(SHARE_LEVELS.map((l) => [l.value, l.label])) as Record<ShareLevel, string>;

/** 관계를 고르면 먼저 골라 두는 공개 범위 */
export const DEFAULT_SHARE_LEVEL: Record<Relation, ShareLevel> = { family: 'realtime', coworker: 'on_anomaly', other: 'on_incident' };

// ── 대응 진행 ──────────────────────────────────────────────────

export const ORDER_LABEL: Record<OrderStatus, string> = {
  assigned: '배달 중',
  held: '보류됨',
  reassigned: '대체배차 완료',
  delivered: '배달 완료',
};

/** 119 자동 신고 단계. 관제센터가 없으니 신고가 막히면 라이더가 직접 걸 수 있게 안내한다. timed: 시각(또는 '진행 중')을 보여 주는가 */
const EMERGENCY_TEXT: Record<EmergencyDelivery, { label: string; sub: string; timed: boolean }> = {
  waiting: { label: '119 자동 신고', sub: '응답이 없으면 비상연락과 함께 바로 신고해요', timed: false },
  sending: { label: '119 자동 신고 중', sub: '신고 문자를 보내고 있어요', timed: true },
  retrying: { label: '119 신고가 늦어지고 있어요', sub: '위급하면 위의 119 전화로 직접 신고해 주세요', timed: true },
  sent: { label: '119 자동 신고', sub: '위치와 라이더 정보를 담아 문자로 신고했어요', timed: true },
  failed: { label: '119 자동 신고 실패', sub: '위의 119 전화로 직접 신고해 주세요', timed: false },
  cancelled: { label: '119 신고', sub: '신고하지 않았어요', timed: false },
};

/** 알린 연락처 — 1명이면 '1순위 김민지', 여럿이면 '1·2순위 김민지 외 1명' */
function notifiedWho(notified: { priority: number; name: string }[]): string {
  const priorities = [...new Set(notified.map((n) => n.priority))].join('·');
  const first = notified[0]!.name;
  return notified.length === 1 ? `${priorities}순위 ${first}` : `${priorities}순위 ${first} 외 ${notified.length - 1}명`;
}

/** Status 화면 '대응 단계' 한 줄 */
export function stepText(step: IncidentStep, incident: IncidentDetailDto): { label: string; sub: string; time: string } {
  const time = step.state === 'now' ? '진행 중' : clock(step.at);
  switch (step.key) {
    case 'detected':
      return {
        label: step.detail.kind === 'fall' ? '전도 감지' : '충격 감지',
        sub:
          step.detail.source === 'phone'
            ? '휴대폰에서 이상 신호를 받았어요'
            : step.detail.source === 'test'
              ? '개발용 감지 테스트예요'
              : '감지 기기에서 이상 신호를 받았어요',
        time,
      };
    case 'response': {
      const r = step.detail.response;
      if (r === 'help') return { label: '도움 요청', sub: '확인 화면에서 직접 요청했어요', time };
      if (r === 'ok') return { label: '괜찮아요 응답', sub: '오탐으로 기록됐어요', time };
      if (r === 'none') return { label: '응답 없음', sub: `${incident.countdownSeconds}초 동안 응답이 없었어요`, time };
      return { label: '라이더 응답 기다리는 중', sub: '확인 화면에서 응답할 수 있어요', time };
    }
    case 'contacts': {
      const d = step.detail;
      if (d.reason === 'no_contacts') return { label: '비상연락처 없음', sub: '비상연락처를 등록해 주세요', time: '' };
      if (step.state === 'skipped') return { label: '비상연락 문자', sub: '보내지 않았어요', time: '' };
      if (!d.notified.length) {
        return step.state === 'todo'
          ? { label: '비상연락 문자 발송', sub: '응답이 없으면 1순위부터 순서대로 알려요', time: '' }
          : { label: '비상연락 문자 발송 중', sub: d.failed ? '문자 발송이 늦어지고 있어요 — 119 신고는 따로 진행돼요' : '현재 위치 링크를 함께 보내요', time };
      }
      const sub = d.acknowledgedBy ? `${d.acknowledgedBy}님이 확인했어요` : d.pending ? '확인이 없으면 다음 순위에게도 알려요' : '현재 위치 링크를 함께 보냈어요';
      return { label: `${notifiedWho(d.notified)}에게 문자 발송`, sub, time };
    }
    case 'emergency': {
      const { label, sub, timed } = EMERGENCY_TEXT[step.detail.delivery];
      return { label, sub, time: timed ? time : '' };
    }
    case 'order':
      return step.detail.status === 'held'
        ? { label: '대체배차 요청', sub: '다른 라이더에게 주문을 넘기는 중이에요', time }
        : { label: '대체배차 완료', sub: '다른 라이더에게 주문을 넘겼어요', time };
    case 'record':
      return { label: '사고기록 저장', sub: '보험·산재 접수에 쓸 수 있어요', time };
  }
}

// ── 기록 화면 ──────────────────────────────────────────────────

export function recordTag(r: Pick<IncidentSummaryDto, 'status' | 'resolution'>): string {
  if (r.status === 'countdown' || r.status === 'escalated') return '대응 중';
  return r.resolution === 'false_alarm' ? '오탐' : '대응 완료';
}

export function responseText(r: IncidentSummaryDto): string {
  if (r.riderResponse === 'help') return `도움 요청${r.responseSeconds != null ? ` · ${r.responseSeconds}초` : ''}`;
  if (r.riderResponse === 'ok') return `괜찮아요${r.responseSeconds != null ? ` · ${r.responseSeconds}초` : ''}`;
  return r.escalationReason === 'no_response' ? '무응답' : '응답 대기';
}

export function recordSummary(r: IncidentSummaryDto): string {
  const what = r.kind === 'fall' ? '전도 감지' : '충격 감지';
  if (r.riderResponse === 'ok' && !r.escalationReason) return `${what} → 괜찮아요 응답`;
  if (r.escalationReason === 'rider_requested') return `${what} → 도움 요청`;
  if (r.escalationReason === 'no_response') return `${what} → 무응답, 비상연락`;
  return `${what} → 응답 대기`;
}

export const contactText = (r: IncidentSummaryDto) =>
  r.notifiedPriorities.length ? `${[...new Set(r.notifiedPriorities)].join('·')}순위 문자 발송` : '보내지 않음';

export const orderText = (r: IncidentSummaryDto) => (r.orderStatus ? ORDER_LABEL[r.orderStatus] : '진행 중 주문 없음');

export const placeText = (r: IncidentSummaryDto) =>
  r.location ? (r.location.address ?? `${r.location.lat.toFixed(4)}, ${r.location.lng.toFixed(4)}`) : '위치 기록 없음';

/** 기록 화면 '기록 공유' — 보험·산재 접수 때 문자·메신저로 보낼 수 있는 글 */
export function recordShareText(r: IncidentSummaryDto): string {
  const map = r.location ? `\n지도: https://maps.google.com/?q=${r.location.lat},${r.location.lng}` : '';
  return [
    '[Rider Guard 사고 기록]',
    `감지 시각: ${dateTime(r.detectedAt)}`,
    `내용: ${recordSummary(r)} (${recordTag(r)})`,
    `감지 위치: ${placeText(r)}${map}`,
    `라이더 응답: ${responseText(r)}`,
    `비상연락: ${contactText(r)}`,
    `주문 처리: ${orderText(r)}`,
  ].join('\n');
}
