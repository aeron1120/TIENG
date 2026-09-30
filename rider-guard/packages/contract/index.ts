/**
 * Rider Guard API 계약 — 서버(apps/server)와 라이더 앱(apps/rider)이 함께 쓰는 요청/응답 타입.
 * 런타임 코드 없이 타입만 둔다. 양쪽 모두 `import type` 으로만 가져오므로 번들/실행 시 해석되지 않는다.
 * 설계 근거: 심야배달라이더_안전시스템_설계문서 (2026-09-10) 4장·6장·9장.
 */

export type ISODate = string;

export type DataSource = 'simulation' | 'mock' | 'measured';
export type Vector3 = [number, number, number];
/** 센서 시각은 기록 시작 기준 초. receivedAt은 별도 수신 시각이며 적분에 사용하지 않는다. */
export type SensorSample = {
  t: number;
  receivedAt?: ISODate;
  seq?: number;
  accG: number | null;
  gyroDps: number | null;
  bankDeg?: number | null;
  dv150?: number | null;
  dvValid?: boolean;
  dvInvalidReason?: string | null;
  /** sensor frame specific force (m/s²); quaternion [w,x,y,z] rotates sensor to world. */
  accelMps2?: Vector3;
  orientation?: [number, number, number, number];
  rawAcc?: Vector3;
  rawGyro?: Vector3;
};
export type SensorMetadata = {
  dataSource: DataSource;
  sampleRateHz?: number | null;
  accRangeG?: number | null;
  gyroRangeDps?: number | null;
  filter?: string | null;
  calibration?: string | null;
  mount?: string | null;
  provenance?: string | null;
};
export type SensorMetricEvidence = {
  key: 'peak_g' | 'peak_gyro' | 'delta_v150' | 'bank_deg';
  unit: string;
  threshold: number;
  value: number | null;
  passedAt: number | null;
  peak: number | null;
  peakAt: number | null;
};
export type SensorAnalysis = {
  ruleVersion: string;
  decision: 'candidate' | 'no_candidate' | 'insufficient';
  candidateAt: number | null;
  windowS: number;
  dvWindowS: number;
  warmupS: number;
  metadata: SensorMetadata;
  evidence: SensorMetricEvidence[];
  quality: {
    missingPackets: number;
    timeAnomalies: number;
    sequenceAvailable: boolean;
    dvValid: boolean;
    dvInvalidReasons: string[];
    dvValidRatio: number | null;
    interval: { from: number; to: number; eligible: number; valid: number };
    saturation: { t: number; accAxes: number[]; gyroAxes: number[] }[];
  };
  /** 表示用でも省略しないイベント波形。nullは欠測として描画する。原本はsensorLogJsonに別途保存。 */
  waveform: { t: number; accG: number | null; gyroDps: number | null; bankDeg: number | null; dv150: number | null; gap: boolean; saturated: boolean }[];
};

export type ApiErrorBody = { error: { code: string; message: string } };

// ── 인증 · 동의 ────────────────────────────────────────────────

/** 필수: locationSensor, shareOnIncident / 선택: insuranceRecords, medicalInfo (9.1, 9.3) */
export type ConsentKey = 'locationSensor' | 'shareOnIncident' | 'insuranceRecords' | 'medicalInfo';
export type Consents = Record<ConsentKey, boolean>;


// ── 회원가입 · 로그인 (이메일 + SNS) ────────────────────────────

export type SocialProvider = 'kakao' | 'naver' | 'google';

/** 서버에 키가 설정된 로그인 수단만 앱에 버튼으로 보인다. */
export type AuthProvidersResponse = { email: true; social: SocialProvider[] };

export type EmailSignupRequest = { email: string; password: string };
export type EmailLoginRequest = { email: string; password: string };

/**
 * SNS 로그인 시작. 앱은 authorizeUrl 을 시스템 브라우저로 열고, 로그인이 끝나면 서버가
 * redirectUri?code=… (실패면 ?error=…) 로 돌려보낸다. code 는 60초짜리 1회용이라 /auth/oauth/exchange 로 바로 바꾼다.
 * sessionKey 는 교환할 때 함께 보낸다 — 코드를 로그인을 시작한 앱에 묶는 열쇠라 앱 밖(주소·로그)으로 내보내지 않는다.
 */
export type OAuthStartRequest = { redirectUri: string };
export type OAuthStartResponse = { authorizeUrl: string; sessionKey: string };
export type OAuthExchangeRequest = { code: string; sessionKey: string };

/** 로그인·가입 결과. onboarded 가 false 면 가입 정보(이름·휴대폰·동의) 화면으로 보낸다. */
export type AuthResponse = { token: string; isNew: boolean; onboarded: boolean };

/** 가입 정보 입력 — 휴대폰 번호는 필수지만 인증하지 않는다 (MVP). */
export type OnboardingRequest = {
  name: string;
  phone: string;
  consents: Pick<Consents, 'locationSensor' | 'shareOnIncident' | 'insuranceRecords'>;
};

export type AccountDto = { email: string | null; hasPassword: boolean; social: SocialProvider[] };

// ── 라이더 · 연락망 · 기기 ─────────────────────────────────────

export type Vehicle = { plate?: string; model?: string };
/** 119 신고 문자에 포함되는 사전 등록 의료정보 (4.3). 민감정보라 medicalInfo 동의가 있어야 저장된다. */
export type MedicalInfo = { bloodType?: string; conditions?: string; allergies?: string };

export type RiderDto = {
  id: string;
  email: string | null;
  /** 가입 정보 입력 전에는 비어 있다. 인증하지 않은 번호다 (MVP). */
  phone: string | null;
  name: string | null;
  vehicle: Vehicle | null;
  medical: MedicalInfo | null;
};
export type UpdateRiderRequest = { name?: string; vehicle?: Vehicle | null; medical?: MedicalInfo | null };

export type Relation = 'family' | 'coworker' | 'other';
/**
 * 공유 대상별 위치 공개 범위 (4.1.2).
 * realtime: 운행 중 실시간 / on_anomaly: 사고 감지(카운트다운) 이후 / on_incident: 사고 확정(에스컬레이션) 이후
 */
export type ShareLevel = 'realtime' | 'on_anomaly' | 'on_incident';

export type ContactDto = {
  id: string;
  priority: number;
  name: string;
  relation: Relation;
  phone: string;
  shareLevel: ShareLevel;
};
export type CreateContactRequest = { name: string; relation: Relation; phone: string; shareLevel?: ShareLevel };
export type UpdateContactRequest = Partial<CreateContactRequest> & { priority?: number };
export type ShareLinkResponse = { url: string; expiresAt: ISODate };

export type DeviceKind = 'tag' | 'webcam';
export type DeviceDto = {
  id: string;
  name: string;
  kind: DeviceKind;
  pairingCode: string;
  connected: boolean;
  battery: number | null;
  lastSeenAt: ISODate | null;
  lastSensorAt?: ISODate | null;
  sensorState?: 'waiting' | 'fresh' | 'stale';
  staleAfterSeconds?: number;
};
export type PairDeviceRequest = { pairingCode: string };

// ── 운행 세션 · 위치 ───────────────────────────────────────────

export type SessionEndReason = 'rider' | 'auto_expired';
export type SessionDto = {
  id: string;
  startedAt: ISODate;
  endedAt: ISODate | null;
  endReason: SessionEndReason | null;
  /** 종료를 잊어도 이 시각에 자동 종료된다 (4.1.1). */
  expiresAt: ISODate;
};

export type LocationPoint = {
  recordedAt: ISODate;
  lat: number;
  lng: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
};
/** 오프라인 동안 쌓인 점도 한 번에 올릴 수 있다 (4.1.4). */
export type UploadLocationsRequest = { points: LocationPoint[] };
export type UploadLocationsResponse = { accepted: number; rejected: number };

export type MeDto = {
  rider: RiderDto;
  account: AccountDto;
  /** 가입 정보(이름·휴대폰·필수 동의)를 마쳤는가. false 면 운행을 시작할 수 없다. */
  onboarded: boolean;
  consents: Consents;
  contacts: ContactDto[];
  device: DeviceDto | null;
  /** 진행 중인 운행 세션. 없으면 수집·공유가 모두 꺼져 있다. */
  session: SessionDto | null;
  /** 오늘(한국 시간) 누적 운행 시간. 세션 진행 중이면 asOf 이후 경과분을 더해 표시한다. */
  today: { driveSeconds: number; asOf: ISODate };
  lastLocation?: IncidentLocation | null;
};

export type LocationAccessDto = {
  at: ISODate;
  accessor: string;
  purpose: 'incident' | 'standing';
  incidentId: string | null;
};

// ── 사고 · 에스컬레이션 ────────────────────────────────────────

export type IncidentSource = 'tag' | 'phone' | 'device' | 'test';
export type IncidentKind = 'impact' | 'fall';
/**
 * 관제 상담원 없이 서버가 끝까지 처리한다.
 * countdown → (괜찮아요) cancelled
 * countdown → (도움 요청 | 무응답) escalated [비상연락 문자 + 119 자동 신고 + 대체배차] → (괜찮아요 | 24시간) resolved
 */
export type IncidentStatus = 'countdown' | 'cancelled' | 'escalated' | 'resolved';
export type RiderResponse = 'ok' | 'help';
export type EscalationReason = 'no_response' | 'rider_requested';
/**
 * false_alarm: 카운트다운 중 '괜찮아요' (예전 기록에는 상담원이 오탐으로 닫은 것도 있다)
 * rider_ok: 비상연락이 시작된 뒤 라이더가 '괜찮아요'로 닫음
 * handled: 라이더 응답 없이 24시간이 지나 자동 종료 (예전 기록에는 상담원이 대응 완료로 닫은 것도 있다)
 */
export type Resolution = 'false_alarm' | 'rider_ok' | 'handled' | 'rider_cancelled';
/**
 * 119 자동 신고가 어디까지 갔는가.
 * waiting: 카운트다운 중 / sending·retrying: 보내는 중(retrying 은 한 번 이상 실패) / failed: 끝내 실패 / cancelled: 보내기 전에 사고가 끝남
 */
export type EmergencyDelivery = 'waiting' | 'sending' | 'retrying' | 'sent' | 'failed' | 'cancelled' | 'simulated';
export type OrderStatus = 'assigned' | 'held' | 'reassigned' | 'delivered';

export type CreateIncidentRequest = {
  source: Exclude<IncidentSource, 'device'>;
  kind: IncidentKind;
  detectedAt?: ISODate;
  location?: { lat: number; lng: number; accuracy?: number };
  /** 태그가 계산한 지표 요약 (5.2 — peakG, deltaV 등) */
  metrics?: Record<string, number>;
};
export type RespondRequest = { response: RiderResponse };

export type IncidentLocation = {
  lat: number;
  lng: number;
  accuracy: number | null;
  address: string | null;
  recordedAt: ISODate;
};

export type OrderDto = { id: string; storeName: string; destination: string; status: OrderStatus };

export type StepState = 'done' | 'now' | 'todo' | 'skipped';
type Step<K extends string, D> = { key: K; state: StepState; at: ISODate | null; detail: D };
/** 사고 대응 진행 단계. 문구는 앱이 key/detail 로 만든다. */
export type IncidentStep =
  | Step<'detected', { source: IncidentSource; kind: IncidentKind }>
  | Step<'response', { response: RiderResponse | 'none' | null; seconds: number | null }>
  | Step<'contacts', { notified: { priority: number; name: string }[]; pending: number; failed: number; acknowledgedBy: string | null; reason: 'no_contacts' | 'simulated' | null }>
  | Step<'emergency', { delivery: EmergencyDelivery }>
  | Step<'order', { status: OrderStatus }>
  | Step<'record', Record<string, never>>;

export type IncidentDetailDto = {
  id: string;
  status: IncidentStatus;
  source: IncidentSource;
  kind: IncidentKind;
  detectedAt: ISODate;
  countdownSeconds: number;
  /** 서버가 이 시각에 무응답 에스컬레이션을 시작한다. */
  deadlineAt: ISODate;
  riderResponse: RiderResponse | null;
  respondedAt: ISODate | null;
  escalationReason: EscalationReason | null;
  escalatedAt: ISODate | null;
  resolution: Resolution | null;
  resolvedAt: ISODate | null;
  location: IncidentLocation | null;
  order: OrderDto | null;
  steps: IncidentStep[];
  /** 기기 시계 오차 보정용 서버 현재 시각 */
  serverTime: ISODate;
  analysis?: SensorAnalysis | null;
  /** 버전 없는 과거 근거는 그대로 제공하며 신형 메타데이터를 지어내지 않는다. */
  evidence?: unknown;
  timeline?: { type: string; at: ISODate; data: Record<string, unknown> | null }[];
  dataSource?: DataSource | 'unknown';
  feedback?: { response: RiderResponse | null; groundTruth: 'unknown' };
  exportAvailable?: boolean;
};
export type ActiveIncidentResponse = { incident: IncidentDetailDto | null };
export type CreateIncidentResponse = { created: boolean; incident: IncidentDetailDto };

export type IncidentSummaryDto = {
  id: string;
  status: IncidentStatus;
  source: IncidentSource;
  kind: IncidentKind;
  detectedAt: ISODate;
  riderResponse: RiderResponse | null;
  responseSeconds: number | null;
  escalationReason: EscalationReason | null;
  resolution: Resolution | null;
  notifiedPriorities: number[];
  orderStatus: OrderStatus | null;
  location: { lat: number; lng: number; address: string | null } | null;
};
export type IncidentListResponse = { items: IncidentSummaryDto[] };

// ── 푸시 ───────────────────────────────────────────────────────

export type PushTokenRequest = { token: string; platform: 'ios' | 'android' };
/** 푸시 data. incident → 사고 확인 화면, status → 대응 상황 화면 */
export type PushData = { type: 'incident' | 'status'; incidentId: string };
/** 알림 버튼 identifier — 잠금화면에서 바로 응답 (설계문서 4.3) */
export type PushAction = 'ok' | 'help';

// ── 감지 기기 API (태그 · 테스트용 웹캠 detector) ──────────────

export type RegisterDeviceRequest = { name: string; kind: DeviceKind };
export type RegisterDeviceResponse = { deviceId: string; deviceToken: string; pairingCode: string };
export type DeviceHeartbeatRequest = { battery?: number };
export type DeviceHeartbeatResponse = { paired: boolean; sessionActive: boolean };
export type DeviceEventRequest = { kind: IncidentKind; detectedAt?: ISODate; metrics?: Record<string, number> };
export type DeviceEventResponse =
  | { status: 'created' | 'duplicate'; incidentId: string }
  | { status: 'ignored'; reason: 'not_paired' | 'no_active_session' };

// ── 지표 수신 (지표 백엔드 → Rider Guard) ──────────────────────
//
// 판정을 이미 내린 기기는 위의 /device-api/events 로 보내고, 지표만 내는 쪽은 여기로 보낸다.
// 서버가 설계문서 5장 흐름(사고 후보 → 사후 무동작 → 경보)으로 판정하고, 경보면 사고를 연다.
// Indicator 모양은 팀의 moto-sensing core/schemas.py 와 같다 — 그쪽 Snapshot 을 그대로 보내도 읽힌다.
//
// 보내는 쪽 규약 (헬멧 태그 6축 IMU, PCX125 헬멧 IMU 사고 후보 탐지 실험 2026-09-28 과 같은 정의):
//   1. 합성 가속도가 3g 이상이면 이벤트를 연다. 3g 이상 표본이 0.5초 넘게 없으면 이벤트를 닫는다.
//      서버 임계값(4g)보다 낮게 여는 건 아슬아슬하게 기각된 정상 충격도 판정 기록에 남기기 위해서다.
//   2. 이벤트 안에서 합성 가속도가 가장 큰 시각을 t_p 라 한다.
//   3. t_p + 30초에 보고 하나를 보낸다 (설계문서 5.1 '30초 정적'). detectedAt 은 t_p 다.
//   4. peak_g 는 t_p 의 값, peak_gyro·delta_v150·bank_deg 는 [t_p − 0.5초, t_p + 0.5초] 안의 최대값이다.
//      기록 전체의 최대값을 보내면 안 된다 — 서로 다른 순간의 충격과 기울기가 한 사고로 묶인다.
//   5. 30초를 다 관찰하지 못했으면(끊김·시뮬레이션 종료) quiet_s 를 state 'low_quality' 로 보낸다.
// 이렇게 보내면 서버가 사고 후보로 본 것은 실험 규칙도 후보로 본다. 반대로 한 이벤트 안에서 가장 큰 충격과 0.5초 넘게
// 떨어진 다른 충격 근처에서만 보조 조건이 섰다면 서버가 놓칠 수 있다. 기준 구현: apps/server/scripts/sim-indicators.ts

export type IndicatorState = 'ok' | 'low_quality' | 'stale' | 'error' | 'no_adapter';
export type SourceMode = 'live' | 'replay' | 'simulated' | 'unavailable';

/** 판정에 쓰는 지표 이름과 단위. 단위가 다르면 판정하지 않고 '판정 불가'로 둔다. */
export type IndicatorUnits = {
  peak_g: 'g'; //         헬멧 태그 합성 가속도(specific force, 정지 시 약 1g) 최대 — 충격
  peak_gyro: 'deg/s'; //  헬멧 태그 합성 각속도 최대 — 회전
  delta_v150: 'm/s'; //   IMU 자세 추정으로 중력을 뺀 선형가속도를 150ms 적분한 크기의 최대 — 속도 급변
  bank_deg: 'deg'; //     IMU 로 추정한 헬멧 기울기 절댓값의 최대. 차체·몸통 기울기가 아니다 — 자세
  quiet_s: 's'; //        보고 시각까지 |가속도 − 1g| < 0.15g 이고 각속도 < 30°/s 인 상태가 끊기지 않고 이어진 시간 — 사후 무동작
};
export type IndicatorKey = keyof IndicatorUnits;

export type Indicator = {
  key: string;
  /** null 이면 값을 못 구한 것이다. 0 으로 바꿔 보내면 안 된다. */
  value: number | null;
  unit: string | null;
  state: IndicatorState;
  sqi: number | null;
  t: number;
};

export type IndicatorReport = {
  indicators: Indicator[];
  /** 기본 live. simulated/replay 는 운영 서버에서 사고를 열지 않는다 — 합성 값으로 실제 연락처를 깨우지 않게. */
  mode?: SourceMode;
  /** 지표를 뽑은 구간의 충격 시각. 없으면 수신 시각 */
  detectedAt?: ISODate;
  /** 같은 판정을 두 번 보내도 사고가 한 번만 열리게 하는 키 (예: 세션 id + 이벤트 id) */
  reportId?: string;
  /** true 면 판정만 돌려주고 기록·사고 생성은 하지 않는다 — 임계값 튜닝용 */
  dryRun?: boolean;
  /** 어디서 온 지표인가 (예: "mujoco:2_frontal", "tag-v1") */
  producer?: string;
  /** 기기/서버 어댑터가 보내는 센서 시각 표본. 웹에서 IMU 수신을 가정하지 않는다. */
  samples?: SensorSample[];
  sensorMetadata?: SensorMetadata;
};

export type RuleTrace = {
  /** impact: 충격, support: 회전·속도 급변·자세 중 하나, post_still: 사후 무동작. 사고 후보 = impact AND support */
  rule: 'impact' | 'support' | 'post_still';
  fired: boolean;
  inputs: Record<string, number | null>;
  thresholds: Record<string, number>;
  /** 채워져 있으면 '기각'이 아니라 '판정 불가'다 (예: "low_quality:quiet_s") */
  blocked_by: string | null;
};

/**
 * alarm: 경보 — 사고를 연다
 * alarm_unverified: 충격은 확실한데 보조 조건이나 무동작을 확인할 수 없음 — 놓침은 되돌릴 수 없어 경보한다(1.3)
 * reject: 기각 (사고 후보 아님, 또는 후보 뒤 계속 움직임)
 * undetermined: 충격 지표(peak_g) 자체가 없어 판정 불가
 */
export type Decision = 'alarm' | 'alarm_unverified' | 'reject' | 'undetermined';

export type IndicatorReportResponse = {
  decision: Decision;
  traces: RuleTrace[];
  /** 무엇을 했는가 */
  action: 'incident_created' | 'incident_existing' | 'logged' | 'dry_run';
  /** logged 인 이유 */
  reason: 'detection_disabled' | 'not_live' | 'no_active_session' | 'not_paired' | 'stale_event' | null;
  incidentId: string | null;
  judgmentId: string | null;
};

// ── 지표 라우터 판정 수신 (POST /v1/detections, 스키마 1.0) ────────
//
// 판정은 지표 라우터(지표팀)가 한다. 서버는 후보 여부를 뒤집지 않고 fired 를 다시 계산하지 않는다 — 조건 이름·기준값·규칙 문장도
// 서버에 없다. 받은 본문을 그대로 남기고 운영 모니터가 evidence 를 받은 순서대로 그린다. 지표팀이 조건을 바꿔도 서버를 고치지 않는다.
// 원본 계약: 지표팀 rider-guard-integration/schemas/detection.v1.schema.json. 모르는 필드는 422 로 거부한다.
// snake_case 는 보내는 쪽(파이썬) 형식을 그대로 둔 것이다.

export type DetectionEvidence = {
  /** 지표 식별자 (소문자 스네이크, 예: impact_g) */
  key: string;
  /** 화면에 그대로 나간다 — 서버가 이름을 정하지 않는다 */
  label: string;
  /** required 가 전부 발동하고 any_of 가 하나 이상 발동하면 사고 후보 */
  group: 'required' | 'any_of';
  /** null 이면 '값 없음'. 0 으로 바꾸지 않는다 */
  value: number | null;
  threshold: number;
  /** abs>= 는 절댓값 비교 (기울기) */
  op: '>=' | 'abs>=';
  unit: string;
  /** 표시 자릿수 0~3 */
  decimals: number;
  /** 라우터가 계산한다. null 이면 값이 없어 판단 못 함 */
  fired: boolean | null;
  /** run_peak: 재생 데이터의 실행 전체 최대값, window: 후보 관찰창 값(실시간) */
  value_basis: 'window' | 'run_peak';
};

export type DetectionReplay = {
  dataset?: string;
  run_id: string;
  scenario_id: string;
  scenario_name: string;
  split?: string;
  /** accident(사고) / 그 밖은 정상 */
  ground_truth: string;
  event_onset_s?: number | null;
  detection_delay_s?: number | null;
  rider_speed_kmh?: number | null;
  duration_s?: number | null;
};

export type DetectionV1 = {
  schema_version: '1.0';
  /** 8~128자, A-Z a-z 0-9 . _ : - — 중복 판단 키 */
  detection_id: string;
  /** 서버의 라이더 ID (앱 계정, 또는 데모 라이더 demo-rider-01) */
  rider_id: string;
  /** 보류·대체배차 대상 주문 */
  order_id?: string | null;
  /** RFC 3339, 시간대 오프셋 필수 */
  occurred_at: ISODate;
  /** source 가 demo 면 실제 위치가 아니다 */
  location?: { lat: number; lng: number; accuracy_m?: number | null; source?: string | null; label?: string | null } | null;
  /** replay 는 문자·119 를 보내지 않는다. replay 면 replay 필수 */
  source: { mode: 'live' | 'replay'; device: 'helmet_tag' | 'phone'; mount: string; replay?: DetectionReplay | null };
  /** status 가 검증 상태 배지 문구를 정한다 (simulation_candidate_only = 실도로 미검증) */
  detector: { name: string; version: string; status: string; profile: string; rule: { expression: string; window_s: number; warmup_s: number } };
  /** 라우터 판정. t_candidate_s 는 스트림 시작 기준 상대 초 — 서버 시각에 더하지 않는다 */
  result: { candidate: boolean; t_candidate_s: number | null };
  /** 1~16행. 받은 순서 그대로 그린다 */
  evidence: DetectionEvidence[];
  quality?: { sample_rate_hz?: number | null; acc_saturation_fraction?: number | null; gyro_saturation_fraction?: number | null } | null;
  /** 서버 2차 확인(사후 무동작)의 입력. 지표팀 규칙이 아니고 기준도 검증되지 않았다 */
  post_event?: { available: boolean; stillness_s?: number | null; observed_s?: number | null; reason?: string | null } | null;
};

/**
 * 사고 등급 (상태와 따로). 후보는 자동 신고가 아니다 — 라이더 확인 단계를 거친다.
 * candidate: 후보(라이더 확인 대기) / alert: 경보(도움 요청, 또는 무응답 + 사후 무동작 확인)
 * alert_no_stillness: 무응답인데 사후 무동작을 확인할 수 없음(재생 데이터는 항상 여기) / dismissed: 라이더가 괜찮다고 함
 * undetermined: 후보인데 근거가 규칙과 어긋남 — 가능한 사고를 버리지 않으려고 사고는 연다
 */
export type IncidentLevel = 'candidate' | 'alert' | 'alert_no_stillness' | 'dismissed' | 'undetermined';
/** open: 라이더 확인 대기(카운트다운) / in_progress: 자동 대응 중(에스컬레이션) / closed: 종료 */
export type DetectionIncidentStatus = 'open' | 'in_progress' | 'closed';
/**
 * evidence_inconsistent: 근거(fired)가 후보 여부와 어긋남 / rider_not_on_duty: 운행 중이 아니라 기록만
 * stale_event: 실시간 사고 시각이 너무 오래됐거나 미래라 기록만 / open_incident_exists: 이미 대응 중인 사고가 있어 새로 열지 않음
 */
export type DetectionWarning = 'evidence_inconsistent' | 'rider_not_on_duty' | 'stale_event' | 'open_incident_exists';

export type DetectionResponseV1 = {
  detection_id: string;
  duplicate: boolean;
  incident_created: boolean;
  incident: {
    id: string;
    status: DetectionIncidentStatus;
    status_label: string;
    level: IncidentLevel;
    level_label: string;
    url: string;
  } | null;
  warnings: DetectionWarning[];
};

// ── 운영 모니터 API (읽기 전용) ─────────────────────────────────
//
// 사고 대응은 전부 자동이라 사람이 누를 버튼이 없다. 자동 대응이 제대로 돌았는지와 판정 근거만 본다.
// 위치·전화번호·차량·의료정보는 싣지 않는다 — 그 정보는 비상연락처와 119 에만 간다.

export type OpsIncidentDto = {
  id: string;
  status: IncidentStatus;
  rider: { name: string };
  detectedAt: ISODate;
  escalatedAt: ISODate | null;
  escalationReason: EscalationReason | null;
  riderResponse: RiderResponse | null;
  resolution: Resolution | null;
  /** 지표 라우터 판정으로 열린 사고만 */
  level: IncidentLevel | null;
  levelLabel: string | null;
  /** 재생 데이터로 열린 사고면 실행 번호와 시나리오 */
  replay: { runId: string; scenarioName: string } | null;
};
export type OpsIncidentDetailDto = OpsIncidentDto & {
  emergency: EmergencyDelivery;
  contacts: { priority: number; name: string; relation: Relation; notifiedAt: ISODate | null; acknowledgedAt: ISODate | null }[];
  order: OrderDto | null;
  timeline: { type: string; at: ISODate; data: Record<string, unknown> | null }[];
  /** 서버 판정(/device-api/indicators)으로 열린 예전 사고의 근거 (producer, mode, decision, traces, indicators) */
  evidence: unknown;
  /** 지표 라우터 판정으로 열린 사고면 받은 본문 전체. 판정 근거 패널은 이 값으로 그린다. 위치는 좌표를 빼고 출처·표시만 */
  detection: OpsDetectionBody | null;
  /** 서버 2차 확인(사후 무동작) 기준 — 검증되지 않은 값 */
  stillnessMinS: number;
};
export type OpsDetectionBody = Omit<DetectionV1, 'location'> & { location: { source: string | null; label: string | null } | null };
/** 최근 수신한 라우터 판정 — 사고를 열지 않은 것(후보 아님)까지 */
export type OpsDetectionDto = {
  detectionId: string;
  receivedAt: ISODate;
  rider: string | null;
  mode: 'live' | 'replay';
  replay: { runId: string; scenarioName: string; groundTruth: string } | null;
  candidate: boolean;
  incidentId: string | null;
  warnings: DetectionWarning[];
};
export type OpsJudgmentDto = {
  id: string;
  receivedAt: ISODate;
  rider: string | null;
  producer: string | null;
  mode: SourceMode;
  decision: Decision;
  action: IndicatorReportResponse['action'];
  reason: IndicatorReportResponse['reason'];
  incidentId: string | null;
  traces: RuleTrace[];
};
/** 운영 모니터: 지금 서버 규칙을 실측 기록(ESP32·MPU6050 29조건 1회차)에 다시 돌린 결과 */
export type OpsRuleCheckDto = {
  ruleVersion: string;
  dataSource: DataSource;
  /** 실험 판정과 후보 여부·첫 후보 시각이 모두 맞은 조건 수 / 전체 */
  matched: number;
  total: number;
  items: {
    id: string;
    name: string;
    class: string;
    /** 이 1회차의 실험 당시 첫 후보 시각(초) */
    expectedAt: number | null;
    decision: SensorAnalysis['decision'];
    candidateAt: number | null;
    match: boolean;
    passed: SensorMetricEvidence['key'][];
    missingPackets: number;
    dvValid: boolean;
  }[];
};
