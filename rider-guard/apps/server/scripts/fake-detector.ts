/**
 * 하드웨어 없이 감지 기기를 흉내 낸다. 등록 후 페어링 코드를 띄우고, 엔터를 누르면 충격 이벤트를 보낸다.
 *   npm run fake-detector            (서버: http://localhost:4000)
 *   API_URL=http://192.168.0.5:4000 npm run fake-detector
 */
import { createInterface } from 'node:readline/promises';

import type { DeviceEventResponse, DeviceHeartbeatResponse, RegisterDeviceResponse } from '@rider-guard/contract';

const api = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Device ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? res.statusText);
  return json;
}

const device = await post<RegisterDeviceResponse>('/device-api/register', { name: '테스트용 웹캠 detector', kind: 'webcam' });
console.log(`\n페어링 코드  ${device.pairingCode.slice(0, 4)} ${device.pairingCode.slice(4)}   ← 앱의 '기기 연결'에 입력하세요\n`);

let battery = 78;
const beat = async () => {
  const state = await post<DeviceHeartbeatResponse>('/device-api/heartbeat', { battery }, device.deviceToken);
  return state;
};
await beat();
const timer = setInterval(() => {
  battery = Math.max(5, battery - 1);
  beat().catch((e: unknown) => console.error('하트비트 실패:', e instanceof Error ? e.message : e));
}, 15_000);

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('close', () => clearInterval(timer));
for (;;) {
  const line = (await rl.question('엔터 = 충격 감지, f = 전도 감지, q = 종료 > ')).trim();
  if (line === 'q') break;
  const state = await beat();
  if (!state.paired) {
    console.log('아직 페어링되지 않았어요.');
    continue;
  }
  const res = await post<DeviceEventResponse>(
    '/device-api/events',
    { kind: line === 'f' ? 'fall' : 'impact', metrics: { peakG: 42.5, deltaV: 3.1 } },
    device.deviceToken,
  );
  console.log(
    res.status === 'ignored'
      ? res.reason === 'no_active_session'
        ? '운행 중이 아니라 무시됐어요. 앱에서 운행을 시작하세요.'
        : '페어링되지 않은 기기예요.'
      : res.status === 'created'
        ? `사고 ${res.incidentId} 생성 — 앱에 확인 화면이 떠요.`
        : `이미 진행 중인 사고 ${res.incidentId} 가 있어요.`,
  );
}
rl.close();
