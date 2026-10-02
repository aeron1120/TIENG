import type { MeDto } from '@rider-guard/contract';

/** Local presentation input only. Never written to the account query cache or an API. */
export function presentationHome(now: number, started: number, worn: boolean): MeDto {
  const sensorAt = new Date(now - 2000).toISOString();
  const locationAt = new Date(now - 5000).toISOString();
  return {
    role: 'rider', canChangeRole: false, onboarded: true,
    rider: { id: 'presentation-home', name: '김도윤', email: null, phone: null, vehicle: { model: 'PCX 125' }, medical: null },
    account: { email: null, hasPassword: false, social: [] },
    consents: { locationSensor: true, shareOnIncident: true, insuranceRecords: false, medicalInfo: false },
    contacts: [],
    device: { id: 'presentation-helmet', name: '헬멧 모듈', kind: 'tag', pairingCode: '', connected: true, battery: 78, lastSeenAt: sensorAt, lastSensorAt: worn ? sensorAt : null, sensorState: worn ? 'fresh' : 'waiting', staleAfterSeconds: 60 },
    session: worn ? { id: 'presentation-drive', startedAt: new Date(started).toISOString(), endedAt: null, endReason: null, expiresAt: new Date(started + 43_200_000).toISOString() } : null,
    today: { driveSeconds: Math.max(0, Math.floor((now - started) / 1000)), asOf: new Date(now).toISOString() },
    lastLocation: { lat: 37.5006, lng: 127.0364, accuracy: 12, recordedAt: locationAt, address: '서울 강남구 테헤란로 152' },
    affiliation: { agency: { id: 'presentation-agency', name: '강남 라이더스' }, platforms: ['baemin', 'coupangeats'], joinedAt: new Date(started).toISOString(), orders: [{ id: 'presentation-order', platform: 'baemin', storeName: '역삼 한그릇', destination: '테헤란로 152', status: 'assigned' }] },
  };
}
