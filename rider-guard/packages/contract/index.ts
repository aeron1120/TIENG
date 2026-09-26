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

export type OtpRequest = { phone: string };
export type OtpResponse = {
  expiresInSeconds: number;
  resendAfterSeconds: number;
  /** 개발 서버에서만 내려준다. 운영에서는 SMS 로만 전달된다. */
  devCode?: string;
};

export type VerifyRequest = {
  phone: string;
  code: string;
  consents: Pick<Consents, 'locationSensor' | 'shareOnIncident' | 'insuranceRecords'>;
};
export type VerifyResponse = { token: string; isNew: boolean; rider: RiderDto };

// ── 라이더 · 연락망 · 기기 ─────────────────────────────────────

export type Vehicle = { plate?: string; model?: string };
/** 119 신고 문자에 포함되는 사전 등록 의료정보 (4.3). 민감정보라 medicalInfo 동의가 있어야 저장된다. */
export type MedicalInfo = { bloodType?: string; conditions?: string; allergies?: string };

export type RiderDto = {
  id: string;
  phone: string;
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

// ── 감지 기기 API (태그 · 테스트용 웹캠 detector) ──────────────

export type RegisterDeviceRequest = { name: string; kind: DeviceKind };
export type RegisterDeviceResponse = { deviceId: string; deviceToken: string; pairingCode: string };
export type DeviceHeartbeatRequest = { battery?: number };
export type DeviceHeartbeatResponse = { paired: boolean; sessionActive: boolean };
export type DeviceEventRequest = { kind: IncidentKind; detectedAt?: ISODate; metrics?: Record<string, number> };
export type DeviceEventResponse =
  | { status: 'created' | 'duplicate'; incidentId: string }
  | { status: 'ignored'; reason: 'not_paired' | 'no_active_session' };

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
};
export type OpsResolveRequest = { outcome: Resolution; note?: string };
export type OpsEmergencyResponse = { mode: 'sms' | 'manual'; report: string };
