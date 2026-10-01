import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Clock } from './lib.ts';
import type { Logger, Providers } from './providers.ts';

export type AppContext = { db: Db; config: Config; clock: Clock; providers: Providers; log: Logger };

// DB 행 타입 (db.ts 스키마와 1:1)

export type RiderRow = {
  id: string;
  email: string | null;
  passwordHash: string | null;
  loginFailures: number;
  lockedUntil: number | null;
  name: string | null;
  phone: string | null;
  onboardedAt: number | null;
  vehicleJson: string | null;
  medicalJson: string | null;
  createdAt: number;
  /** 첫 로그인 때 고른 역할. 아직 안 골랐으면 null */
  role?: 'rider' | 'dispatcher' | null;
  /** 소속 배달대행사 (라이더·관제사 모두) */
  agencyId?: string | null;
  agencyJoinedAt?: number | null;
  /** 일하는 플랫폼 (DeliveryPlatform[]). 아직 정하지 않았으면 null */
  platformsJson?: string | null;
};

export type ContactRow = {
  id: string;
  riderId: string;
  priority: number;
  name: string;
  relation: 'family' | 'coworker' | 'other';
  phone: string;
  shareLevel: 'realtime' | 'on_anomaly' | 'on_incident';
  createdAt: number;
};

export type DeviceRow = {
  id: string;
  tokenHash: string;
  kind: 'tag' | 'webcam' | 'phone';
  name: string;
  pairingCode: string;
  riderId: string | null;
  battery: number | null;
  lastSeenAt: number | null;
  lastSensorAt?: number | null;
  createdAt: number;
  pairedAt: number | null;
};

export type SessionRow = {
  id: string;
  riderId: string;
  startedAt: number;
  endedAt: number | null;
  endReason: 'rider' | 'auto_expired' | null;
  expiresAt: number;
};

export type LocationRow = {
  id: number;
  riderId: string;
  sessionId: string;
  recordedAt: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
};

export type OrderRow = {
  id: string;
  riderId: string;
  storeName: string;
  destination: string;
  status: 'assigned' | 'held' | 'reassigned' | 'delivered';
  incidentId: string | null;
  reassignRequestedAt: number | null;
  /** 대행사 관제사가 배정한 주문 — 사고 때 대체배차도 그 관제사가 한다 */
  agencyId?: string | null;
  platform?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type IncidentRow = {
  id: string;
  riderId: string;
  sessionId: string | null;
  deviceId: string | null;
  source: 'tag' | 'phone' | 'device' | 'test';
  kind: 'impact' | 'fall';
  detectedAt: number;
  receivedAt: number;
  countdownSeconds: number;
  deadlineAt: number;
  status: 'countdown' | 'cancelled' | 'escalated' | 'resolved';
  riderResponse: 'ok' | 'help' | null;
  respondedAt: number | null;
  escalationReason: 'no_response' | 'rider_requested' | null;
  escalatedAt: number | null;
  resolution: 'false_alarm' | 'rider_cancelled' | 'rider_ok' | 'handled' | null;
  resolvedAt: number | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  locationAt: number | null;
  address: string | null;
  metricsJson: string | null;
  sensorLogJson: string | null;
  evidenceJson: string | null;
  reportKey: string | null;
  orderId: string | null;
};

export type DetectionRow = {
  id: string;
  bodyHash: string;
  bodyJson: string;
  responseJson: string;
  riderId: string | null;
  incidentId: string | null;
  mode: 'live' | 'replay';
  candidate: number;
  receivedAt: number;
};

export type IncidentEventRow ={ id: number; incidentId: string; type: string; at: number; dataJson: string | null };

export type NotificationRow = {
  id: string;
  incidentId: string;
  /** 119 신고는 연락처가 아니라 null */
  contactId: string | null;
  /** contact_*: 비상연락처 문자 / emergency_report: 119 자동 신고 / emergency_update: 신고 뒤 라이더 상태가 바뀌었다는 119 후속 문자 */
  purpose: 'contact_alert' | 'contact_update' | 'emergency_report' | 'emergency_update';
  recipient: string;
  body: string;
  dueAt: number;
  status: 'pending' | 'sending' | 'sent' | 'simulated' | 'failed' | 'cancelled';
  attempts: number;
  sentAt: number | null;
  error: string | null;
};

export type ShareLinkRow = {
  tokenHash: string;
  riderId: string;
  contactId: string;
  incidentId: string | null;
  scope: 'incident' | 'standing';
  createdAt: number;
  expiresAt: number;
  acknowledgedAt: number | null;
};
