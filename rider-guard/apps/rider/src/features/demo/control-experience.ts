import type { TourStep } from '../../components/tour/steps.ts';
import { reduce, type DemoAction, type DemoState } from './engine.ts';
import { demoTutorialSteps } from './tutorial.ts';

export const hasAgencyActivity = (board: { riders: readonly unknown[]; orders: readonly unknown[]; incidents: readonly unknown[] }) =>
  board.riders.length > 0 || board.orders.length > 0 || board.incidents.length > 0;

/** Screen-local state: never writes agency APIs, presentation sessions or other browser tabs. */
export function controlExperienceReducer(state: DemoState, action: DemoAction): DemoState {
  const next = reduce(state, action);
  return action.type === 'tick' && next.incident && next.playing ? reduce(next, { type: 'pause' }) : next;
}

const RESPONSE_TARGETS = new Set(['demo-ack', 'demo-call', 'demo-reassign-BT-2041-r2', 'demo-reassign-BT-2043-r4', 'demo-resolve']);

export function controlTutorialSteps(s: DemoState, picked: string | null): TourStep[] {
  return [
    { target: 'control-help', title: '관제 흐름을 직접 따라가요', body: '라이더 상태 확인부터 사고 접수, 연락, 주문 인계까지 관제사의 업무를 차례로 진행합니다.', hint: '밝게 표시된 버튼을 누르면 상황이 이어져요. 도움말에서 언제든 다시 시작할 수 있어요.' },
    { target: 'control-agency', title: '대행사 연결이 완료됐어요', body: '등록한 대행사 이름과 가입 코드를 확인합니다. 라이더 가입 코드는 배달기사에게, 관제사 초대 코드는 함께 일할 관제사에게 전달하세요.' },
    { target: 'control-select-r1', fallbackTarget: 'demo-control', title: '라이더 한 명을 선택해요', body: '김도윤 라이더를 눌러 주세요. 선택한 라이더의 위치, 보호 상태와 진행 중인 주문이 함께 표시됩니다.', interaction: 'press', actionLabel: '김도윤 라이더', complete: picked === 'r1' },
    { target: 'control-map', fallbackTarget: 'demo-control', title: '위치와 진행 주문을 확인해요', body: '선택한 라이더의 위치를 지도에서 확인합니다. 사고가 발생하면 같은 지도에 사고 위치가 표시되고, 아래 주문도 해당 라이더 기준으로 이어집니다.' },
    { target: 'control-start', title: '사고 대응 흐름을 시작해요', body: '사고 대응 시작을 눌러 주세요. 정상 주행 파형에 이어 충격이 감지되면 라이더 확인 요청과 관제 사건이 나타납니다.', interaction: 'press', actionLabel: '사고 대응 시작', complete: s.playing || s.t > 0 },
    { target: 'control-detection', fallbackTarget: 'demo-control', title: '센서 신호를 확인하고 있어요', body: '라이더의 주행 신호를 확인합니다. 사고 후보가 감지되면 자동으로 멈추고 다음 단계로 이어집니다.', interaction: 'wait', complete: !!s.incident },
    { target: 'control-incident', fallbackTarget: 'demo-control', title: '라이더 응답을 먼저 기다려요', body: '사고 후보가 감지됐어요. 라이더가 괜찮다고 응답하면 대응을 취소하고, 도움이 필요하거나 응답이 없으면 관제 대응으로 이어집니다.', hint: '설명을 읽는 동안 카운트다운은 멈춰 있어요.' },
    { target: 'control-wait', fallbackTarget: 'control-detection', title: '미응답 상황으로 이어가요', body: '응답 대기 건너뛰기를 눌러 주세요. 미응답으로 관제에 접수되고, 비상연락 기록과 주문 보류가 함께 표시됩니다.', interaction: 'press', actionLabel: '응답 대기 건너뛰기', complete: !!s.incident?.response },
    ...demoTutorialSteps(s).filter((step) => RESPONSE_TARGETS.has(step.target)),
    { target: 'control-events', fallbackTarget: 'demo-control', title: '처리 기록이 모두 남아요', body: '사고 감지, 접수, 전화, 대체 배차와 종결까지 최근 이벤트에서 확인합니다. 각 주문에도 가게·고객 안내 이력이 남아 있어요.' },
    { target: 'control-report', fallbackTarget: 'demo-control', title: '관제 대응을 완료했어요', body: '라이더 선택부터 사고 대응과 주문 인계까지 마쳤어요. 안내를 마친 뒤 기록 버튼에서 이번 처리 내역을 다시 확인할 수 있습니다.', hint: '도움말을 다시 누르면 처음부터 체험할 수 있어요.' },
  ];
}
