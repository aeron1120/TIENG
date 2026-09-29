import type { IncidentDetailDto, IncidentStep, IncidentSummaryDto, OrderStatus, Relation } from '@rider-guard/contract';

const pad = (n: number) => String(n).padStart(2, '0');

export function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function dateTime(iso: string, withYear = true): string {
  const d = new Date(iso);
  const date = `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}.${date}` : date;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 휴대폰 번호를 입력하는 대로 010-1234-5678 꼴로. 서버는 숫자만 저장한다. */
export function formatMobile(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length < 4) return d;
  if (d.length < 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, -4)}-${d.slice(-4)}`;
}

/** 서버(normalizeMobile)와 같은 기준 */
export const isMobile = (value: string) => /^01[016789]\d{7,8}$/.test(value.replace(/\D/g, ''));

export const RELATION_LABEL: Record<Relation, string> = { family: '가족', coworker: '동료 라이더', other: '지인' };

export const ORDER_LABEL: Record<OrderStatus, string> = {
  assigned: '배달 중',
  held: '보류됨',
  reassigned: '대체배차 완료',
  delivered: '배달 완료',
};

/** Status 화면 '대응 단계' 한 줄 */
export function stepText(step: IncidentStep, incident: IncidentDetailDto): { label: string; sub: string; time: string } {
  const time = step.state === 'now' ? '진행 중' : clock(step.at);
  switch (step.key) {
    case 'detected':
      return {
        label: step.detail.kind === 'fall' ? '전도 감지' : '충격 감지',
        sub: step.detail.source === 'phone' ? '휴대폰 센서에서 감지' : step.detail.source === 'test' ? '개발용 감지 테스트' : '감지 기기에서 사고 이벤트 수신',
        time,
      };
    case 'response': {
      const r = step.detail.response;
      if (r === 'help') return { label: '라이더 응답: 도움 요청', sub: '확인 화면에서 직접 요청', time };
      if (r === 'ok') return { label: '라이더 응답: 괜찮아요', sub: '오탐으로 기록됐어요', time };
      if (r === 'none') return { label: '라이더 응답 없음', sub: `${incident.countdownSeconds}초 동안 응답이 없었어요`, time };
      return { label: '라이더 응답 기다리는 중', sub: '확인 화면에서 응답할 수 있어요', time };
    }
    case 'contacts': {
      const d = step.detail;
      if (d.reason === 'no_contacts') return { label: '비상연락처 없음', sub: '연락망에서 연락처를 등록해 주세요', time: '' };
      if (step.state === 'skipped') return { label: '비상연락 문자', sub: '보내지 않았어요', time: '' };
      if (!d.notified.length) {
        return step.state === 'todo'
          ? { label: '비상연락 문자 발송', sub: '응답이 없으면 1순위부터 순서대로 알려요', time: '' }
          : { label: '비상연락 문자 발송 중', sub: d.failed ? '문자 발송이 늦어지고 있어요 — 관제센터가 함께 확인해요' : '현재 위치 링크 포함', time };
      }
      const who = d.notified.map((n) => n.priority).join('·');
      const sub = d.acknowledgedBy ? `${d.acknowledgedBy}님이 확인했어요` : d.pending ? '확인이 없으면 다음 순위에게도 알려요' : '현재 위치 링크 포함';
      return { label: `비상연락 ${who}순위 문자 발송`, sub, time };
    }
    case 'center': {
      const { phase, outcome } = step.detail;
      if (phase === 'queued') return { label: '관제센터 접수', sub: '곧 담당자가 확인해요', time };
      if (phase === 'reviewing') return { label: '관제센터 확인', sub: '담당자가 사고 내용을 검토하고 있어요', time };
      if (phase === 'closed') return { label: '관제센터 확인 완료', sub: outcome === 'false_alarm' ? '오탐으로 확인됐어요' : '대응을 마쳤어요', time };
      return { label: '관제센터 확인', sub: step.state === 'skipped' ? '연결하지 않았어요' : '비상연락과 함께 연결돼요', time: '' };
    }
    case 'emergency':
      return { label: '119 신고', sub: step.detail.mode === 'sms' ? '관제센터가 119에 문자로 신고했어요' : '관제센터가 119에 신고했어요', time };
    case 'order':
      return step.detail.status === 'held'
        ? { label: '대체배차 요청', sub: '다른 라이더에게 주문을 넘기는 중이에요', time }
        : { label: '대체배차 완료', sub: '다른 라이더에게 주문 인계', time };
    case 'record':
      return { label: '사고기록 저장', sub: '보험·산재 접수에 쓸 수 있어요', time };
  }
}

// ── 기록 화면 ──────────────────────────────────────────────────

export function recordTag(r: Pick<IncidentSummaryDto, 'status' | 'resolution'>): string {
  if (r.status === 'countdown' || r.status === 'escalated' || r.status === 'reviewing') return '대응 중';
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
  r.location ? (r.location.address ?? `${r.location.lat.toFixed(4)}, ${r.location.lng.toFixed(4)}`) : '위치 없음';

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
