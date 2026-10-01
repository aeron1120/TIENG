type Device = { kind: string; sensorState?: string; lastSensorAt?: string | null; staleAfterSeconds?: number };
type Input = { sessionActive: boolean; device: Device | null; phoneStatus: string; locationAt?: string | null; locationPermission?: string; now: number };
type Action = 'enable_phone' | 'connection' | 'refresh' | 'settings' | null;

function age(at: string | null | undefined, now: number): number | null {
  if (!at) return null;
  const seconds = (now - Date.parse(at)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
}
const elapsed = (seconds: number) => seconds < 60 ? `${seconds}초 전` : `${Math.floor(seconds / 60)}분 전`;

/** A fresh server response is not necessarily a fresh sensor measurement. */
export function protectionReadiness(input: Input) {
  const { device, sessionActive, phoneStatus, now } = input;
  const seconds = age(device?.lastSensorAt, now);
  const validSource = !!device && !device.kind.includes('webcam');
  const sensorFresh = sessionActive && validSource && device.sensorState === 'fresh' && seconds !== null && seconds < (device.staleAfterSeconds ?? 60);
  const source = device?.kind === 'phone' ? '휴대폰 센서' : validSource ? '헬멧 센서' : '센서 연결 전';
  let title = sensorFresh ? '센서 신호 수신 중' : sessionActive ? '센서 연결 확인 필요' : '운행 시작 전';
  let detail = device?.kind === 'phone' ? '휴대폰 위치에서 측정한 신호예요. 헬멧과는 다른 측정 조건입니다.' : '최근 신호를 기준으로 연결 상태를 확인해요.';
  let action: Action = sensorFresh ? null : sessionActive ? 'connection' : 'settings';
  if (!sensorFresh && sessionActive) {
    if (phoneStatus === 'needs_permission') {
      title = '동작 센서 권한이 필요해요';
      detail = '휴대폰에서 아래 버튼을 눌러 센서 사용을 허용해 주세요.';
      action = 'enable_phone';
    } else if (phoneStatus === 'denied') {
      title = '동작 센서 권한이 꺼져 있어요';
      detail = '브라우저 설정에서 이 사이트의 동작 및 방향 접근을 허용한 뒤 다시 확인해 주세요.';
      action = 'enable_phone';
    } else if (phoneStatus === 'unsupported' || phoneStatus === 'no_sensor') {
      detail = '이 환경에서 휴대폰 센서 신호를 확인하지 못했어요. 휴대폰 브라우저 또는 연결한 헬멧 기기를 확인해 주세요.';
      action = 'connection';
    } else if (phoneStatus === 'starting' || (phoneStatus === 'running' && !device?.lastSensorAt)) {
      title = '첫 센서 전송을 기다리고 있어요';
      detail = '기기에서 신호를 받더라도 서버 수신을 확인할 때까지 보호 중으로 표시하지 않아요.';
      action = 'refresh';
    } else if (device?.kind === 'phone' || phoneStatus === 'running') {
      detail = '휴대폰 화면을 켠 채 네트워크 연결을 확인하고 서버 수신을 다시 확인해 주세요. 최근 측정이 도착할 때까지 감지 상태를 확인할 수 없어요.';
      action = 'refresh';
    } else {
      detail = '헬멧 전원과 연결을 확인해 주세요. 신호를 다시 받을 때까지 감지 상태를 확인할 수 없어요.';
    }
  }
  const locationAge = age(input.locationAt, now);
  const locationText = input.locationPermission === 'denied' ? '위치 권한 꺼짐'
    : locationAge === null ? '최근 위치 없음'
    : `${elapsed(locationAge)}${locationAge >= 120 ? ' · 오래된 위치' : ''}`;
  return { source, sensorFresh, title, detail, action, sensorText: seconds === null ? '측정 기록 없음' : `${elapsed(seconds)}${sensorFresh ? '' : ' · 연결 확인 필요'}`, locationText };
}
