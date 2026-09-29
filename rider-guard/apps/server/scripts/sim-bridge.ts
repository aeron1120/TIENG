/**
 * 시뮬레이션 결과를 지표 백엔드처럼 Rider Guard 에 보낸다.
 *
 *   npm run sim -- results/2_frontal.csv results/3_speedbump.csv --dry-run
 *       판정만 받아 본다. 기록도 사고도 남지 않는다 — 임계값 맞출 때
 *   npm run sim -- results/1_lowside.csv
 *       기기로 등록 → 앱에서 페어링 코드 입력 → 운행 중이면 경보까지 실제로 흐른다
 *
 *   --api <url>     서버 주소 (기본 http://localhost:4000, 또는 API_URL)
 *   --token <tok>   이미 등록한 기기 토큰을 다시 쓴다 (페어링 생략)
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { DeviceHeartbeatResponse, IndicatorReport, IndicatorReportResponse, RegisterDeviceResponse } from '@rider-guard/contract';

import { indicatorsFromSim, parseSimCsv } from './sim-indicators.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const dryRun = args.includes('--dry-run');
const api = (flag('--api') ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
let token = flag('--token');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('사용법: npm run sim -- <results/*.csv ...> [--dry-run] [--api url] [--token tok]');
  process.exit(1);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Device ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `${res.status} ${res.statusText}`);
  return json;
}

if (!token) {
  const device = await post<RegisterDeviceResponse>('/device-api/register', { name: 'MuJoCo 시뮬레이션', kind: 'tag' });
  token = device.deviceToken;
  console.log(`기기 토큰: ${token}  (다음 실행에서 --token 으로 재사용)`);
  if (!dryRun) {
    console.log(`\n페어링 코드  ${device.pairingCode.slice(0, 4)} ${device.pairingCode.slice(4)}   ← 앱의 '기기 연결'에 입력하세요. 기다리는 중…`);
    while (!(await post<DeviceHeartbeatResponse>('/device-api/heartbeat', {})).paired) await new Promise((r) => setTimeout(r, 2000));
    console.log('페어링됨\n');
  }
}

const runId = new Date().toISOString();
for (const file of files) {
  const name = basename(file, '.csv');
  const indicators = indicatorsFromSim(parseSimCsv(readFileSync(file, 'utf8')));
  const report: IndicatorReport = { indicators, mode: 'simulated', producer: `mujoco:${name}`, reportId: `${name}@${runId}`, dryRun };
  const res = await post<IndicatorReportResponse>('/device-api/indicators', report);

  console.log(`■ ${name}: ${res.decision}  →  ${res.action}${res.reason ? ` (${res.reason})` : ''}${res.incidentId ? `  사고 ${res.incidentId}` : ''}`);
  for (const i of indicators) console.log(`    ${i.key.padEnd(13)} ${i.value?.toFixed(3).padStart(9)} ${i.unit}`);
  for (const t of res.traces) {
    const inputs = Object.entries(t.inputs).map(([k, v]) => `${k}=${v?.toFixed(3) ?? '—'}`).join(' ');
    const limits = Object.entries(t.thresholds).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`    [${t.fired ? '발동' : t.blocked_by ? '판정불가' : '미발동'}] ${t.rule}  ${inputs}  | ${limits}${t.blocked_by ? `  (${t.blocked_by})` : ''}`);
  }
}
