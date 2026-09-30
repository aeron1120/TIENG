import type { DeviceDto, IndicatorReport, IndicatorReportResponse, PhoneSensorRequest, SensorSample } from '@rider-guard/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { api, ApiError } from '@/api/client';
import { keys } from '@/api/hooks';

/**
 * 휴대폰 자체 센서(가속도계·자이로)를 헬멧 센서 대신 쓴다 — 헬멧 기기가 없을 때, 운행 세션 동안만.
 *
 *   15초마다 PUT /me/phone-sensor  받은 표본 수만 알린다(서버가 '센서 수신'으로 표시). 파형은 보내지 않는다.
 *   가속도 4g 이상이면           그 앞 0.8초 ~ 뒤 0.6초 표본을 POST /me/indicators 로 — 판정은 서버가 헬멧과 같은 규칙
 *                               (imu-report-v1: 6g AND (300°/s OR ΔV OR 뱅크각))으로 한다. 4g 는 보낼지 말지만 정하는 문턱.
 *
 * 한계 — 기록 상세에 그대로 남긴다:
 *   휴대폰은 헬멧이 아니라 주머니·거치대에 있다. 같은 6g 라도 머리가 받은 충격과 뜻이 다르다.
 *   ΔV·뱅크각은 자세 추정이 없어 보내지 않는다(null + 사유). 휴대폰 가속도계는 ±8g 에서 잘리는 기종도 있다.
 *
 * 웹(휴대폰 브라우저) 전용: devicemotion 이벤트. iOS 는 버튼을 눌러 권한을 받아야 한다(enablePhoneSensor).
 * 네이티브 앱은 expo-sensors 가 들어간 새 빌드가 필요해 아직 'unsupported'.
 */

export type PhoneSensorStatus =
  | 'off' // 운행 중이 아니다
  | 'needs_permission' // iOS — 버튼을 눌러야 한다
  | 'starting' // 첫 표본을 기다린다
  | 'running'
  | 'no_sensor' // 이벤트가 오지 않는다 (데스크탑 등)
  | 'denied'
  | 'unsupported'
  | 'device_paired'; // 헬멧 기기가 연결돼 있다 — 그쪽을 쓴다

type State = { status: PhoneSensorStatus; rateHz: number | null; lastTriggerAt: number | null };
let state: State = { status: 'off', rateHz: null, lastTriggerAt: null };
const listeners = new Set<() => void>();
const setState = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const usePhoneSensorState = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

const G = 9.80665;
const KEEP_S = 3;
const TRIGGER_G = 4;
const BEFORE_S = 0.8;
const AFTER_S = 0.6;
const COOLDOWN_MS = 5_000;
const BEAT_MS = 15_000;
const NO_SENSOR_MS = 3_000;

type MotionPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };
const motionApi = (): (typeof DeviceMotionEvent & MotionPermission) | null =>
  Platform.OS === 'web' && typeof window !== 'undefined' && 'DeviceMotionEvent' in window ? (window.DeviceMotionEvent as typeof DeviceMotionEvent & MotionPermission) : null;

let permitted = false;

/** iOS: 사용자가 누른 버튼 안에서 불러야 한다 */
export async function enablePhoneSensor(): Promise<boolean> {
  const api = motionApi();
  if (!api) return false;
  if (!api.requestPermission) return (permitted = true);
  try {
    permitted = (await api.requestPermission()) === 'granted';
  } catch {
    permitted = false;
  }
  if (!permitted) setState({ status: 'denied' });
  else wake?.();
  return permitted;
}
/** 권한을 받은 뒤 듣기를 다시 시작하게 하는 연결 (usePhoneSensor 가 채운다) */
let wake: (() => void) | null = null;

export function usePhoneSensor(sessionId: string | null, device: DeviceDto | null | undefined) {
  const qc = useQueryClient();
  const otherDevice = !!device && device.kind !== 'phone';

  useEffect(() => {
    if (!sessionId) return setState({ status: 'off' });
    if (otherDevice) return setState({ status: 'device_paired' });
    const motion = motionApi();
    if (!motion) return setState({ status: 'unsupported' });

    let stopped = false;
    let listening = false;
    let seq = 0;
    let origin: number | null = null;
    let lastT = -1;
    let received = 0;
    let firstAt: number | null = null;
    const buffer: SensorSample[] = [];
    let pending: number | null = null;
    let cooldownUntil = 0;

    const send = async (triggerT: number) => {
      const samples = buffer.filter((s) => s.t >= triggerT - BEFORE_S);
      const report: IndicatorReport = {
        indicators: [],
        mode: 'live',
        producer: 'phone-imu-web',
        reportId: `phone-${sessionId}-${Math.round(triggerT * 1000)}`,
        samples,
        sensorMetadata: {
          dataSource: 'measured',
          // 브라우저 이벤트 간격이 흔들려 고정 표본률로 누락을 판정하지 않는다 — 누락은 순번으로 본다
          sampleRateHz: null,
          accRangeG: null,
          gyroRangeDps: null,
          filter: null,
          calibration: null,
          mount: 'phone',
          provenance: `휴대폰 브라우저 devicemotion${state.rateHz ? ` 약 ${Math.round(state.rateHz)}Hz` : ''} — 헬멧이 아닌 휴대폰 위치의 가속도·각속도. ΔV·뱅크각 없음`,
        },
      };
      try {
        const res = await api<IndicatorReportResponse>('POST', '/me/indicators', report);
        if (res.incidentId) void qc.invalidateQueries({ queryKey: keys.active });
      } catch {
        // 다음 충격에서 다시 보낸다 — 사고 확인은 사용자 화면(테스트)으로도 할 수 있다
      }
    };

    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const now = e.timeStamp;
      origin ??= now;
      const t = Math.round(((now - origin) / 1000) * 10_000) / 10_000;
      if (t <= lastT) return;
      lastT = t;
      const r = e.rotationRate;
      const gyro = r && r.alpha != null && r.beta != null && r.gamma != null ? Math.hypot(r.alpha, r.beta, r.gamma) : null;
      const accG = Math.hypot(a.x, a.y, a.z) / G;
      buffer.push({ t, seq: seq++, accG: Math.round(accG * 10_000) / 10_000, gyroDps: gyro === null ? null : Math.round(gyro * 10) / 10, bankDeg: null, dv150: null, dvValid: false, dvInvalidReason: 'phone_no_orientation' });
      while (buffer.length && buffer[0].t < t - KEEP_S) buffer.shift();
      received++;
      if (firstAt === null) {
        firstAt = Date.now();
        setState({ status: 'running' });
      }
      // 한 번만 — 이벤트마다 상태를 바꾸면 화면이 60Hz 로 다시 그려진다
      if (e.interval > 0 && !state.rateHz) setState({ rateHz: 1000 / e.interval });

      if (pending !== null && t >= pending + AFTER_S) {
        const at = pending;
        pending = null;
        void send(at);
      } else if (pending === null && accG >= TRIGGER_G && Date.now() >= cooldownUntil && t >= 0.15) {
        pending = t;
        cooldownUntil = Date.now() + COOLDOWN_MS;
        setState({ lastTriggerAt: Date.now() });
      }
    };

    const listen = () => {
      if (listening || stopped) return;
      listening = true;
      setState({ status: 'starting' });
      window.addEventListener('devicemotion', onMotion);
      setTimeout(() => {
        if (!stopped && firstAt === null) setState({ status: 'no_sensor' });
      }, NO_SENSOR_MS);
    };
    wake = listen;
    if (!motion.requestPermission || permitted) listen();
    else setState({ status: 'needs_permission' });

    const beat = async () => {
      const body: PhoneSensorRequest = { samples: received, sampleRateHz: state.rateHz };
      received = 0;
      try {
        const device = await api<DeviceDto>('PUT', '/me/phone-sensor', body);
        // 홈이 15초 폴링을 기다리지 않고 바로 '보호 중'으로
        qc.setQueryData(keys.me, (me: { device: DeviceDto | null } | undefined) => (me ? { ...me, device } : me));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'device_paired') {
          stopped = true;
          window.removeEventListener('devicemotion', onMotion);
          setState({ status: 'device_paired' });
        }
      }
    };
    // 첫 표본이 모일 즈음 한 번, 그다음은 15초마다
    const first = setTimeout(() => void beat(), NO_SENSOR_MS + 500);
    const timer = setInterval(() => void beat(), BEAT_MS);

    return () => {
      stopped = true;
      wake = null;
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('devicemotion', onMotion);
      setState({ status: 'off', rateHz: null });
    };
  }, [sessionId, otherDevice, qc]);
}
