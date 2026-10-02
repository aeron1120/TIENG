import type { TourStep } from '../../components/tour/steps.ts';
import type { DemoAction, DemoState } from './engine.ts';

/** The same buttons and reducer drive both the free demonstration and its tutorial. */
export function demoTutorialSteps(s: DemoState): TourStep[] {
  const incident = s.incident;
  const handedOff = (id: string) => s.orders.find((order) => order.id === id)?.status === 'reassigned';
  return [
    { target: 'demo-help', title: '직접 해보는 안전 대응', body: 'A1 충돌 사례로 라이더의 도움 요청부터 관제 대응과 주문 인계까지 함께 진행합니다.', hint: '밝게 표시된 버튼을 눌러 주세요. 안내를 읽는 동안에는 상황이 기다려요.' },
    { target: 'demo-start', title: '먼저 주행을 시작해요', body: '강조된 시작 버튼을 눌러 주세요. 헬멧 센서 파형이 재생되고 라이더의 보호 상태가 함께 바뀝니다.', interaction: 'press', actionLabel: '시작', complete: s.playing || s.t > 0 },
    { target: 'demo-sensor', title: '센서가 충격을 감지하고 있어요', body: '정상 주행에 이어 충돌 파형을 재생합니다. 사고 후보가 감지되면 라이더 확인 화면으로 이어져요.', hint: '파형 재생 중 · 감지되면 자동으로 다음 단계로 이동해요.', interaction: 'wait', complete: !!incident },
    { target: 'demo-rider', title: '라이더에게 먼저 확인해요', body: '강한 충격이 감지돼 응답을 요청합니다. 괜찮다면 대응을 취소하고, 도움이 필요하거나 응답이 없으면 관제로 이어집니다.', hint: '지금은 설명을 읽을 수 있도록 카운트다운이 멈춰 있어요.' },
    { target: 'demo-response-help', fallbackTarget: 'demo-rider', title: '도움을 요청해 보세요', body: '라이더 화면의 도움이 필요해요를 눌러 주세요. 기다리지 않고 관제와 비상연락처로 상황이 전달됩니다.', interaction: 'press', actionLabel: '도움이 필요해요', complete: incident?.response === 'help' },
    { target: 'demo-status', title: '사고 대응과 주문 보류', body: '도움 요청이 접수됐어요. 라이더의 위치와 연락 기록을 공유하고, 진행 중인 주문 두 건을 보류합니다. 이제 관제사가 이어받을 차례예요.' },
    { target: 'demo-ack', fallbackTarget: 'demo-control', title: '관제 담당자로 접수해요', body: '접수하고 담당 지정을 눌러 주세요. 담당자가 지정되고 라이더에게 관제에서 확인했다는 상태가 표시됩니다.', interaction: 'press', actionLabel: '접수하고 담당 지정', complete: !!incident?.assignee },
    { target: 'demo-call', fallbackTarget: 'demo-control', title: '라이더 상태를 확인해요', body: '라이더에게 전화를 눌러 상태를 확인하세요. 연락 결과가 사건의 대응 기록에 남습니다.', interaction: 'press', actionLabel: '라이더에게 전화', complete: !!incident?.calls.length },
    { target: 'demo-reassign-BT-2041-r2', fallbackTarget: 'demo-order-BT-2041', title: '첫 번째 주문을 인계해요', body: 'BT-2041 주문을 이서준 라이더에게 넘겨 주세요. 주문 담당자가 바뀌고 가게와 고객에게 안내 기록이 남아요.', interaction: 'press', actionLabel: '이서준에게 인계', complete: handedOff('BT-2041') },
    { target: 'demo-reassign-BT-2043-r4', fallbackTarget: 'demo-order-BT-2043', title: '남은 주문도 연결해요', body: 'BT-2043 주문은 최민재 라이더에게 넘겨 주세요. 두 주문의 보류가 모두 풀리면 사고 라이더는 대응에 집중할 수 있어요.', interaction: 'press', actionLabel: '최민재에게 인계', complete: handedOff('BT-2043') },
    { target: 'demo-resolve', fallbackTarget: 'demo-control', title: '대응 기록을 마무리해요', body: '연락과 주문 인계를 확인했어요. 대응 완료를 눌러 관제 처리 기록을 종결해 주세요.', interaction: 'press', actionLabel: '대응 완료', complete: incident?.status === 'resolved' },
    { target: 'demo-status', title: '전체 흐름을 완료했어요', body: '센서 감지 → 라이더 확인 → 관제 접수 → 연락 → 주문 인계까지 직접 진행했어요. 보고서에서 기록을 확인하거나 다른 사례로 다시 시연할 수 있습니다.', hint: '도움말을 누르면 새 상황으로 처음부터 다시 체험할 수 있어요.' },
  ];
}

/** Freeze as soon as detection arrives, so reading never consumes the response window. */
export function tutorialClockActions(s: DemoState): DemoAction[] {
  return s.playing && !!s.incident ? [{ type: 'pause' }] : [];
}
