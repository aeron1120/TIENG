import type { SensorAnalysis } from '@rider-guard/contract';
import type { PresentationSession } from '../../../../../packages/demo/presentation.ts';
import type { TourStep } from '../../components/tour/steps.ts';
import { MAIN_RIDER, type DemoState, type LogEntry } from './engine.ts';

type Access = { kind: 'server'; id: string; token: string } | { kind: 'local' | 'unavailable' };
export type ReportSource = { kind: 'server'; session: PresentationSession } | { kind: 'local'; state: DemoState; analysis: SensorAnalysis | null };
const credential = /^[A-Za-z0-9_-]{1,128}$/;

export function reportAccess(hash: string, connection: { sessionId: string | null; monitorUrl: string | null }, apiUrl: string): Access {
  const parse = (fragment: string): Access => {
    const params = new URLSearchParams(fragment.replace(/^#/, ''));
    const id = params.get('session'), token = params.get('key');
    return [...params.keys()].length === 2 && credential.test(id ?? '') && credential.test(token ?? '')
      ? { kind: 'server', id: id!, token: token! } : { kind: 'unavailable' };
  };
  // An explicit link always wins over this tab's saved/recovered session.
  if (hash && hash !== '#') return parse(hash);
  if (connection.monitorUrl) {
    try {
      const url = new URL(connection.monitorUrl), expected = new URL(`${apiUrl}/ops/presentation`);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.search || url.username || url.password) return { kind: 'unavailable' };
      const access = parse(url.hash);
      return access.kind === 'server' && (!connection.sessionId || connection.sessionId === access.id) ? access : { kind: 'unavailable' };
    } catch { return { kind: 'unavailable' }; }
  }
  return { kind: connection.sessionId ? 'unavailable' : 'local' };
}

export const REPORT_STATUS: Record<string, string> = {
  monitoring: '감지 대기', confirming: '라이더 확인 중', rider_ok: '본인 확인 · 대응 취소', escalated: '관제 접수 대기',
  acknowledged: '관제 대응 중', resolved: '대응 종결', no_candidate: '사고 후보 없음', insufficient: '판정 정보 부족',
};
export const REPORT_ACTOR: Record<string, string> = { sensor: '센서', system: '시스템', rider: '라이더', control: '관제', order: '주문' };
export const REPORT_ORDER: Record<string, string> = { delivering: '배달 중', held: '보류', reassigned: '인계 완료', delivered: '배달 완료' };
const METRICS = { peak_g: ['합성 가속도', 'g'], peak_gyro: ['합성 각속도', '°/s'], delta_v150: ['속도 변화 ΔV', 'm/s'], bank_deg: ['|뱅크각|', '°'] } as const;
const cleanResult = (text: string) => text.replace(/\s*\(시연\)/g, '');
type Metric = { key: string; label: string; unit: string; peak: number | null; threshold: number; operator: '>=' | 'abs>='; fired: boolean | null; triggerValue: number | null; passedAt: number | null; basis: string; decimals: number };

/** Presentation labels only; source order and raw messages remain in sourceSnapshot. */
function eventLabel(entry: LogEntry): { code: string; description: string } {
  const text = entry.text;
  if (entry.actor === 'sensor' && text.startsWith('사고 후보 감지')) return { code: 'DETECTED', description: '사고 후보 감지' };
  if (entry.actor === 'rider' && text.startsWith('라이더에게 확인 요청')) return { code: 'RESPONSE_REQUESTED', description: '라이더 확인 요청' };
  if (entry.actor === 'rider' && text.includes('도움이 필요해요')) return { code: 'RIDER_RESPONSE', description: '라이더 도움 요청' };
  if (entry.actor === 'rider' && text.includes('괜찮아요')) return { code: 'RIDER_RESPONSE', description: '본인 확인 · 이상 없음 응답' };
  if (entry.actor === 'system' && text.includes('본인 응답이 없었어요')) return { code: 'RESPONSE_TIMEOUT', description: '응답 대기 만료' };
  if (entry.actor === 'system' && text.startsWith('관제에 사건 접수')) return { code: 'ESCALATED', description: '관제 접수 요청 · 비상연락 위치 공유 기록' };
  if (entry.actor === 'system' && text.startsWith('119 신고문')) return { code: 'EMERGENCY_RECORD', description: '긴급 신고 처리 기록' };
  if (entry.actor === 'control' && text.includes('사건 접수 · 담당 지정')) return { code: 'ACKNOWLEDGED', description: text.split(' — ')[0] };
  if (entry.actor === 'control' && text.startsWith('라이더에게 전화')) return { code: 'RIDER_CONTACT', description: cleanResult(text) };
  if (entry.actor === 'order' && text.startsWith('진행 주문')) return { code: 'ORDER_HELD', description: text };
  if (entry.actor === 'order' && text.includes('대체 배차')) return { code: 'ORDER_REASSIGNED', description: cleanResult(text).replace('안내 발송', '안내 기록') };
  if (entry.actor === 'control' && text.startsWith('대응 완료')) return { code: 'CLOSED', description: '관제 대응 종결 · 보고서 생성' };
  return { code: `${entry.actor.toUpperCase()}_RECORD`, description: cleanResult(text) };
}

/** A report projection of the received snapshot. The database still stores sessionJson and command sequence hashes. */
export function buildReport(source: ReportSource, generatedAt = new Date().toISOString()) {
  const session = source.kind === 'server' ? source.session : null;
  const s = source.kind === 'server' ? source.session.state : source.state;
  const a = source.kind === 'server' ? source.session.analysis : source.analysis;
  const i = s.incident, detection = session?.detection ?? null;
  const id = session?.id ?? `local-${s.baseWall}`;
  const at = (t: number | null) => t === null ? null : new Date(s.baseWall + t * 1000).toISOString();
  const name = (riderId: string) => s.riders.find((rider) => rider.id === riderId)?.name ?? riderId;
  const visibleEvidence = !!i || s.clipDone;
  const metrics: Metric[] = !visibleEvidence ? [] : a ? a.evidence.map((e) => ({
    key: e.key, label: METRICS[e.key][0], unit: METRICS[e.key][1], peak: e.peak, threshold: e.threshold,
    operator: e.key === 'bank_deg' ? 'abs>=' : '>=', fired: e.passedAt !== null ? true : null,
    triggerValue: e.value, passedAt: e.passedAt, basis: 'event_interval', decimals: e.key === 'peak_g' || e.key === 'delta_v150' ? 2 : 1,
  })) : (detection?.evidence ?? []).map((e) => ({
    key: e.key, label: e.label, unit: e.unit, peak: e.value, threshold: e.threshold,
    operator: e.op, fired: e.fired, triggerValue: null, passedAt: null, basis: e.value_basis, decimals: e.decimals,
  }));
  const orders = (i ? s.orders.filter((order) => order.originalRiderId === MAIN_RIDER) : []).map(({ notices: _notices, ...order }) => ({
    ...order, incidentId: i!.id, originalRiderName: name(order.originalRiderId), riderName: name(order.riderId),
  }));
  const notifications = s.orders.filter((order) => orders.some((row) => row.id === order.id)).flatMap((order) => order.notices.map((notice, index) => ({
    id: `${id}:${order.id}:notice:${index + 1}`, incidentId: i!.id, orderId: order.id, occurredAt: at(notice.t)!, recipient: notice.to, message: notice.text,
  })));
  // Paused actions can share a timestamp. The append-only source log is the order authority.
  const timeline = s.log.flatMap((entry, sourceLogIndex) => !i || entry.t < i.detectedT - 0.001 ? [] : [{
    id: `${id}:${i.id}:event:${sourceLogIndex}`, incidentId: i.id, sourceLogIndex, ...eventLabel(entry),
    occurredAt: at(entry.t)!, elapsedS: +(entry.t - i.detectedT).toFixed(3), actor: entry.actor,
    orderIds: orders.filter((order) => entry.text.includes(order.id)).map((order) => order.id),
  }]);
  const missed = s.log.some((entry) => entry.actor === 'sensor' && (entry.text.includes('판정하지 못했어요') || entry.text.includes('판정 불가')));
  const status = i?.status ?? (!s.clipDone ? 'monitoring' : missed || a?.decision === 'insufficient' || (!a && !detection) ? 'insufficient' : 'no_candidate');
  return {
    schemaVersion: 'baton.incident-report.v1', id, generatedAt, status,
    provenance: { storage: session ? 'server' : 'browser', source: session?.source ?? null },
    receipt: session ? { sessionId: session.id, receivedAt: session.receivedAt, sequence: session.lastSequence, expiresAt: session.expiresAt } : null,
    incident: i ? { id: i.id, riderId: MAIN_RIDER, status: i.status, detectedAt: at(i.detectedT)!, sensorTimeS: i.candidateClipT,
      response: i.response, respondedAt: at(i.respondedT), assignee: i.assignee, acknowledgedAt: at(i.ackT), resolvedAt: at(i.resolvedT) } : null,
    riders: s.riders.filter((rider) => rider.id === MAIN_RIDER || orders.some((order) => order.riderId === rider.id)),
    metrics, orders, notifications, timeline,
    // Explicit fields keep read/write credentials out of downloaded reports.
    sourceSnapshot: { state: s, analysis: a, detection, clip: session?.clip ?? null },
  };
}
export type IncidentReport = ReturnType<typeof buildReport>;

export function reportTourSteps(structureOpen: boolean): TourStep[] {
  return [
    { target: 'report-help', title: '진행한 흐름을 기록으로 확인해요', body: '사건 식별자부터 감지 근거, 대응 이력, 주문 인계와 저장 구조까지 순서대로 확인합니다.' },
    { target: 'report-receipt', title: '같은 기록이 수신됐는지 확인해요', body: '기록 ID와 마지막 서버 수신 시각, 수신 순번을 확인합니다. 앞 화면의 조작이 서버에 반영되면 이 기록도 갱신됩니다.' },
    { target: 'report-incident', title: '사건 하나를 기준으로 연결해요', body: '사건 ID를 기준으로 라이더, 감지 시각, 담당자와 처리 상태를 묶습니다. 아래 이력과 주문도 같은 사건에 연결됩니다.' },
    { target: 'report-metrics', title: '판정에 사용한 지표를 비교해요', body: '가속도·각속도·속도 변화·뱅크각의 관측값과 기준을 같은 단위로 확인합니다. 관측 최댓값과 조건 충족값은 구분해서 기록합니다.' },
    { target: 'report-timeline', title: '조작이 처리 이력으로 남아요', body: '라이더 응답, 관제 접수, 연락, 주문 인계와 종결을 발생 시각·처리 주체·이벤트 코드로 정리합니다.' },
    { target: 'report-orders', title: '주문별 인계 결과를 확인해요', body: '주문 ID마다 이전 담당자와 현재 담당자를 비교합니다. 가게·고객·라이더 안내는 주문 ID로 연결된 별도 기록으로 남습니다.' },
    { target: 'report-structure-open', title: '저장 구조를 열어 보세요', body: '저장 구조 보기를 눌러 화면의 항목이 어떤 데이터 필드로 연결되는지 확인합니다.', interaction: 'press', actionLabel: '저장 구조 보기', complete: structureOpen },
    { target: 'report-structure', fallbackTarget: 'report-storage', title: '원본과 보고서 항목을 함께 보관해요', body: '서버에는 수신된 상태와 순번이 저장됩니다. 보고서는 이를 사건·지표·이력·주문으로 정리하며, JSON에는 원본 스냅샷도 포함됩니다.' },
    { target: 'report-export', title: '확인한 보고서를 내보내요', body: 'JSON 저장은 연결된 데이터와 원본을 파일로 보관합니다. 인쇄·PDF 저장은 지금 보는 보고서를 문서로 남깁니다.', hint: '안내를 마치고 저장 버튼을 사용할 수 있어요. 도움말은 언제든 다시 시작할 수 있습니다.' },
  ];
}
