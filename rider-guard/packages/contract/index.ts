/**
 * Rider Guard API 계약 — 서버(apps/server)와 라이더 앱(apps/rider)이 함께 쓰는 요청/응답 타입.
 * 런타임 코드 없이 타입만 둔다. 양쪽 모두 `import type` 으로만 가져오므로 번들/실행 시 해석되지 않는다.
 * 설계 근거: 심야배달라이더_안전시스템_설계문서 (2026-09-10) 4장·6장·9장.
 */

export type ISODate = string;

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
  centerPhone: string;
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
 * countdown → (괜찮아요) cancelled
 * countdown → (도움 요청 | 무응답) escalated → (상담원 배정) reviewing → resolved
 */
export type IncidentStatus = 'countdown' | 'cancelled' | 'escalated' | 'reviewing' | 'resolved';
export type RiderResponse = 'ok' | 'help';
export type EscalationReason = 'no_response' | 'rider_requested';
export type Resolution = 'false_alarm' | 'handled';
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
  | Step<'contacts', { notified: { priority: number; name: string }[]; pending: number; failed: number; acknowledgedBy: string | null; reason: 'no_contacts' | null }>
  | Step<'center', { phase: 'waiting' | 'queued' | 'reviewing' | 'closed'; outcome: Resolution | null }>
  | Step<'emergency', { mode: 'sms' | 'manual' }>
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
// 서버가 설계문서 5장 흐름(충격·전도 → 사후 무동작 → 경보)으로 판정하고, 경보면 사고를 연다.
// Indicator 모양은 팀의 moto-sensing core/schemas.py 와 같다 — 그쪽 Snapshot 을 그대로 보내도 읽힌다.

export type IndicatorState = 'ok' | 'low_quality' | 'stale' | 'error' | 'no_adapter';
export type SourceMode = 'live' | 'replay' | 'simulated' | 'unavailable';

/**
 * 판정에 쓰는 지표 이름과 단위. 단위가 다르면 판정하지 않고 '판정 불가'로 둔다.
 * MuJoCo 시뮬레이션 요약표(태그·폰·질량중심)와 같은 정의다.
 */
export type IndicatorUnits = {
  delta_v: 'm/s'; //        태그 위치, 100ms 간격 속도 벡터 차이의 최대값 — 충격 판정의 중심 (5.2)
  delta_v_com: 'm/s'; //    라이더 질량중심 ΔV. 시뮬레이션에서만 나오는 기준값이라 판정에는 쓰지 않는다
  peak_g: 'g'; //           태그 합성 가속도 피크. 접촉 강성에 크게 흔들려 참고용
  peak_g_phone: 'g'; //     폰 위치 피크 가속도 (실기기는 ±16g 포화)
  peak_gyro: 'rad/s'; //    태그 합성 각속도 피크 (로우사이드 미끄러짐·회전)
  tilt_deg: 'deg'; //       몸통의 수직 대비 기울기 (최종값) — 전도 판정 (5.3)
  speed: 'm/s'; //          태그 속도 크기 (최종값)
  accel_var_1s: 'm/s^2'; // 마지막 1초 가속도 크기의 표준편차 — 사후 무동작 (5.4)
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
};

export type RuleTrace = {
  rule: 'impact' | 'fall_posture' | 'post_still';
  fired: boolean;
  inputs: Record<string, number | null>;
  thresholds: Record<string, number>;
  /** 채워져 있으면 '기각'이 아니라 '판정 불가'다 (예: "low_quality:accel_var_1s") */
  blocked_by: string | null;
};

/**
 * alarm: 경보 — 사고를 연다
 * alarm_unverified: 충격·전도는 확실한데 무동작을 확인할 수 없음 — 놓침은 되돌릴 수 없어 경보한다(1.3)
 * reject: 기각 (충격 없음, 또는 충격 뒤 계속 움직임)
 * undetermined: 충격·전도 지표 자체가 없어 판정 불가
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

// ── 관제 콘솔 API ──────────────────────────────────────────────

export type OpsIncidentDto = {
  id: string;
  status: IncidentStatus;
  urgent: boolean;
  rider: { name: string; phone: string };
  detectedAt: ISODate;
  escalatedAt: ISODate | null;
  escalationReason: EscalationReason | null;
  riderResponse: RiderResponse | null;
  operatorName: string | null;
  resolution: Resolution | null;
};
export type OpsIncidentDetailDto = OpsIncidentDto & {
  rider: { name: string; phone: string; vehicle: Vehicle | null; medical: MedicalInfo | null };
  location: IncidentLocation | null;
  contacts: { priority: number; name: string; relation: Relation; notifiedAt: ISODate | null; acknowledgedAt: ISODate | null }[];
  order: OrderDto | null;
  timeline: { type: string; at: ISODate; data: Record<string, unknown> | null }[];
  /** 지표 판정으로 열린 사고면 그 근거 (producer, mode, decision, traces, indicators) */
  evidence: unknown;
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
export type OpsResolveRequest = { outcome: Resolution; note?: string };
export type OpsEmergencyResponse = { mode: 'sms' | 'manual'; report: string };
