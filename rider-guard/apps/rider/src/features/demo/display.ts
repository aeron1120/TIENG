import { MAIN_RIDER, waitLeft, type DemoAction, type DemoState, type EventClip } from './engine.ts';

type MutationConnection = { status: string; canResume: boolean };

export function presentationMutationBlock(c: MutationConnection): string | null {
  if (c.canResume) return '발표 화면에서 이전 시연을 먼저 복구한 뒤 응답하거나 관제를 조작해 주세요.';
  if (c.status === 'connecting' || c.status === 'restoring') return '발표 화면에서 서버 연결·복구를 마친 뒤 응답하거나 관제를 조작해 주세요.';
  if (c.status === 'retrying') return '서버 수신을 확인하는 동안 응답과 관제 조작을 잠시 멈췄어요.';
  if (c.status === 'error') return '발표 화면에서 연결을 복구하거나 새 시연을 시작한 뒤 조작해 주세요.';
  return null;
}

/** Check again at press time, including a connection change before the next render. */
export function dispatchPresentationAction(c: MutationConnection, action: DemoAction, dispatch: (action: DemoAction) => void): void {
  if (!presentationMutationBlock(c)) dispatch(action);
}

/** Reset clears engine autopilot, so every explicit play reapplies the selected mode. */
export function presentationPlaybackActions(s: DemoState, automatic: boolean, driver: string): DemoAction[] {
  return s.playing ? [{ type: 'pause' }] : [{ type: 'autopilot', on: automatic }, { type: 'play', driver }];
}

type StageKey = 'ready' | 'watching' | 'confirming' | 'escalated' | 'handoff' | 'rider_ok' | 'resolved' | 'insufficient' | 'no_candidate';
export type PresentationStage = {
  key: StageKey;
  title: string;
  description: string;
  tone: 'neutral' | 'warning' | 'danger' | 'success';
  step: number;
  skippedSteps: number[];
  finished: boolean;
};

/** Presentation language describes evidence and simulated actions, never rescue outcomes. */
export function presentationStage(s: DemoState, clip: EventClip | null): PresentationStage {
  const stage = (key: StageKey, title: string, description: string, tone: PresentationStage['tone'], step: number, finished = false, skippedSteps: number[] = []): PresentationStage => ({ key, title, description, tone, step, finished, skippedSteps });
  const i = s.incident;
  if (i?.status === 'confirming') return stage('confirming', '사고 후보 · 라이더 응답 대기', `사고 후보를 감지해 라이더 응답을 기다려요; ${Math.ceil(waitLeft(s) ?? 0)}초 안에 응답이 없으면 관제 대응으로 이어져요.`, 'danger', 2);
  if (i?.status === 'rider_ok') return stage('rider_ok', '라이더 확인 · 대응 취소', '라이더가 괜찮다고 응답해 연락과 주문 보류를 생략했으며, 실제 사고 여부를 확정하지는 않아요.', 'neutral', 5, true, [3, 4]);
  if (i?.status === 'resolved') {
    const held = s.orders.filter((o) => o.originalRiderId === MAIN_RIDER && o.status === 'held').length;
    return stage('resolved', '시연 대응 종결', `시연의 관제 대응이 종결됐어요${held ? ` (보류 주문 ${held}건 남음)` : ''}; 실제 구조 완료를 뜻하지 않으며 보고서에서 처리 기록을 확인할 수 있어요.`, 'neutral', 5, true);
  }
  if (i?.status === 'escalated') return stage('escalated', i.response === 'help' ? '도움 요청 · 관제 대응' : '미응답 · 관제 대응', `${i.response === 'help' ? '라이더가 도움을 요청해' : '라이더 응답이 없어'} 비상연락을 기록하고 주문을 보류했어요; 관제 접수를 기다리고 있어요.`, 'danger', 3);
  if (i?.status === 'acknowledged') {
    const held = s.orders.filter((o) => o.originalRiderId === MAIN_RIDER && o.status === 'held').length;
    return stage('handoff', held ? '관제 접수 · 주문 인계' : '주문 인계 · 대응 중', held ? `관제사가 사건을 접수했어요; 보류 주문 ${held}건을 대체 라이더에게 넘길 차례예요.` : '주문을 대체 라이더에게 넘겼어요; 관제 대응을 마치면 시연 기록을 종결해요.', 'warning', 4);
  }
  if (s.clipDone) {
    const missed = s.log.some((l) => l.actor === 'sensor' && (l.text.includes('판정하지 못했어요') || l.text.includes('판정 불가')));
    if (clip?.decision === 'insufficient' || missed) return stage('insufficient', '판정 불가 · 데이터 부족', '사건 구간의 데이터가 부족하거나 센서가 끊겨 사고 후보 여부를 판정하지 못했어요; 수신 상태와 품질 근거를 확인해 주세요.', 'warning', 5, true, [2, 3, 4]);
    return stage('no_candidate', '판정 종료 · 사고 후보 없음', '수신한 사건 구간이 사고 후보 조건을 채우지 않아 연락과 주문 보류 없이 판정을 마쳤어요.', 'success', 5, true, [2, 3, 4]);
  }
  if (s.sensorLost) return stage('watching', '센서 연결 확인 필요', '헬멧 센서 수신이 끊겼어요; 실험 옵션에서 센서를 다시 연결한 뒤 재생해 주세요.', 'warning', 1);
  if (s.t === 0) return stage('ready', '시연 준비', '시나리오와 자동·수동 모드를 고른 뒤 시작하면 서버 연결과 함께 같은 사건을 재생해요.', 'neutral', 0);
  return stage('watching', '센서 수신 · 판정 대기', '실측 파형을 재생하며 사고 후보 조건을 확인하고 있어요; 아직 라이더에게 확인을 요청한 사건은 없어요.', 'neutral', 1);
}
