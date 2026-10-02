export type TourStep = {
  target: string; title: string; body: string; hint?: string;
  /** An action can mount only after the preceding action changes the screen. */
  fallbackTarget?: string;
  interaction?: 'press' | 'wait';
  actionLabel?: string;
  complete?: boolean;
};

export const canAdvanceTourStep = (step: TourStep) => !step.interaction || step.complete === true;

export const HOME_TOUR: TourStep[] = [
  { target: 'home-help', title: '내 안전 상태를 함께 살펴봐요', body: '보호 상태와 센서 연결, 위치, 소속 정보를 차례로 안내합니다. 도움말을 누르면 언제든 다시 볼 수 있어요.', hint: '안내 중에도 센서 수신과 사고 감지는 계속돼요.' },
  { target: 'home-map', title: '보호 상태와 내 위치', body: '지도 위에서 보호 상태와 위치를 확인합니다. 현재 GPS와 서버에 마지막으로 전달된 위치는 다를 수 있어요.' },
  { target: 'home-timeline', title: '헬멧을 쓰면 보호가 시작돼요', body: '헬멧 착용에 따라 보호가 자동으로 켜집니다. 시작 시각과 착용 시간을 확인하고, 최근 센서 신호까지 도착했는지 살펴보세요.' },
  { target: 'home-metrics', title: '헬멧·음성·위치를 한 번에', body: '헬멧 연결과 음성 응답 상태, 마지막 위치 시각을 빠르게 확인합니다. 꺼짐이나 기록 없음이 보이면 설정을 확인해 주세요.' },
  { target: 'home-readiness', title: '실제로 감지할 준비가 되었나요?', body: '감지 센서 출처와 마지막 수신 시각, 서버에 전달된 위치를 확인합니다. 화면의 안내에 따라 권한이나 연결을 점검해 주세요.' },
  { target: 'home-sound', title: '발표 전 경고음을 준비해요', body: '경고음 준비·시험을 눌러 브라우저 소리를 준비합니다. 사고 확인 대기 중 반복되는 소리를 미리 확인할 수 있어요.' },
  { target: 'home-affiliation', title: '소속과 진행 중인 주문', body: '배달대행사와 플랫폼, 진행 주문을 확인합니다. 이 카드를 눌러 소속을 연결하거나 수정할 수 있어요.' },
  { target: 'home-notifications', title: '놓친 알림을 확인해요', body: '보호 상태 변화와 연락처 관련 알림을 모아 볼 수 있어요. 새 알림이 있으면 이곳에 표시됩니다.' },
  { target: 'home-nav', title: '기록과 설정도 여기에서', body: '보호 탭으로 홈에 돌아오고, 기록에서 지난 운행을 확인합니다. 설정에서는 기기와 비상연락처 등 보호에 필요한 정보를 관리해요.', hint: '준비됐어요. 안내를 마치면 화면을 직접 조작할 수 있어요.' },
];
