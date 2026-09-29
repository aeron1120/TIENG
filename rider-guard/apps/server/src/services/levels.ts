import type { DetectionIncidentStatus, DetectionV1, IncidentLevel } from '@rider-guard/contract';

import type { IncidentRow } from '../context.ts';

/**
 * 라우터 판정으로 열린 사고의 등급과 상태 표시. 순수 함수 — 수신(/v1/detections)과 운영 모니터가 같이 쓴다.
 * 등급은 사고 상태와 따로 간다: 상태는 대응이 어디까지 갔는가, 등급은 사고일 가능성을 무엇으로 확인했는가.
 */

export const LEVEL_LABEL: Record<IncidentLevel, string> = {
  candidate: '후보 (라이더 확인 대기)',
  alert: '경보',
  alert_no_stillness: '경보 (무동작 확인 불가)',
  dismissed: '기각',
  undetermined: '판정 불가',
};

export const STATUS_LABEL: Record<DetectionIncidentStatus, string> = {
  open: '라이더 확인 대기',
  in_progress: '자동 대응 중',
  closed: '종료',
};

export function statusOf(status: IncidentRow['status']): DetectionIncidentStatus {
  return status === 'countdown' ? 'open' : status === 'escalated' ? 'in_progress' : 'closed';
}

/**
 * 근거가 후보 여부와 맞는가 — required 가 전부 발동하고 any_of 가 하나 이상 발동했으면 후보여야 한다.
 * fired 는 라우터가 계산한 값을 그대로 믿는다. 값과 기준을 다시 비교하지 않는다 (기준값을 서버에 두지 않으려고).
 */
export function evidenceConsistent(d: Pick<DetectionV1, 'evidence' | 'result'>): boolean {
  const required = d.evidence.filter((e) => e.group === 'required');
  const anyOf = d.evidence.filter((e) => e.group === 'any_of');
  const ruleFired = required.every((e) => e.fired === true) && (anyOf.length === 0 || anyOf.some((e) => e.fired === true));
  return ruleFired === d.result.candidate;
}

/**
 * 연동 명세 5장. 사후 무동작은 지표팀 규칙이 아니라 서버의 2차 확인이고 기준(stillnessMinS)도 검증되지 않았다.
 * 무응답인데 움직임이 있으면 명세는 '상담원 확인'이지만 상담원이 없으므로 대응은 그대로 에스컬레이션하고 등급만 후보로 둔다.
 */
export function levelOf(
  incident: Pick<IncidentRow, 'riderResponse' | 'escalationReason' | 'resolution'>,
  d: Pick<DetectionV1, 'evidence' | 'result' | 'post_event'>,
  stillnessMinS: number,
): { level: IncidentLevel; label: string } {
  const is = (level: IncidentLevel) => ({ level, label: LEVEL_LABEL[level] });
  if (incident.resolution === 'false_alarm' || incident.resolution === 'rider_ok') return is('dismissed');
  if (incident.riderResponse === 'help') return is('alert');
  if (incident.escalationReason === 'no_response') {
    const p = d.post_event;
    if (!p?.available || p.stillness_s == null) return is('alert_no_stillness');
    if (p.stillness_s >= stillnessMinS) return is('alert');
    return { level: 'candidate', label: '후보 (무응답 · 움직임 있음)' };
  }
  return is(evidenceConsistent(d) ? 'candidate' : 'undetermined');
}
