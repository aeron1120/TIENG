/**
 * 헬멧 IMU 시뮬레이션 결과를 지표 백엔드처럼 Rider Guard 에 보낸다.
 *
 *   npm run sim -- <pcx125_helmet>/results_telemetry_validation/result_helmet.csv --dry-run
 *       판정만 받아 본다. 기록도 사고도 남지 않는다 — 임계값 맞출 때
 *   npm run sim -- <발표 자료>/data/runs/A1_v00/nominal_200hz.csv.gz
 *       기기로 등록 → 앱에서 페어링 코드 입력 → 운행 중이면 경보까지 실제로 흐른다
 *
 *   --api <url>     서버 주소 (기본 http://localhost:4000, 또는 API_URL)
 *   --token <tok>   이미 등록한 기기 토큰을 다시 쓴다 (페어링 생략)
 *   --brief         보고마다 한 줄만 찍는다 (실행이 많을 때)
 *
 * 시뮬레이션은 수 초에서 끝나 충격 뒤 30초 무동작을 끝까지 볼 수 없다. 그래서 quiet_s 가 품질 미달로 가고,
 * 사고 후보는 'alarm_unverified' 로 나온다 — 앞 단계(사고 후보) 판정만 실험과 비교할 수 있다.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { Decision, DeviceHeartbeatResponse, IndicatorReport, IndicatorReportResponse, RegisterDeviceResponse } from '@rider-guard/contract';

import { parseImuCsv, reportsFromImu } from './sim-indicators.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const dryRun = args.includes('--dry-run');
const brief = args.includes('--brief');
const api = (flag('--api') ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
let token = flag('--token');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('사용법: npm run sim -- <*.csv | *.csv.gz ...> [--dry-run] [--brief] [--api url] [--token tok]');
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
  const device = await post<RegisterDeviceResponse>('/device-api/register', { name: 'MuJoCo 헬멧 시뮬레이션', kind: 'tag' });
  token = device.deviceToken;
  console.log(`기기 토큰: ${token}  (다음 실행에서 --token 으로 재사용)`);
  if (!dryRun) {
    console.log(`\n페어링 코드  ${device.pairingCode.slice(0, 4)} ${device.pairingCode.slice(4)}   ← 앱의 '기기 연결'에 입력하세요. 기다리는 중…`);
    while (!(await post<DeviceHeartbeatResponse>('/device-api/heartbeat', {})).paired) await new Promise((r) => setTimeout(r, 2000));
    console.log('페어링됨\n');
  }
}

const readText = (file: string) => {
  const buf = readFileSync(file);
  return (file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
};
/** data/runs/A1_v00/nominal_200hz.csv.gz → A1_v00/nominal_200hz */
const nameOf = (file: string) => `${basename(dirname(file))}/${basename(file).replace(/\.csv(\.gz)?$/, '')}`;

/** 실행마다 가장 강한 판정 — 한 번이라도 경보면 그 실행은 사고 후보로 잡힌 것이다 */
const RANK: Decision[] = ['undetermined', 'reject', 'alarm_unverified', 'alarm'];
const summary: { run: string; decision: Decision | null }[] = [];

const runId = new Date().toISOString();
for (const file of files) {
  for (const [run, rows] of parseImuCsv(readText(file))) {
    const name = run ?? nameOf(file);
    const reports = reportsFromImu(rows);
    console.log(`■ ${name}${reports.length ? '' : ': 보고 없음 (3g 이상 충격 없음)'}`);
    let strongest: Decision | null = null;
    for (const [k, { tPeak, indicators, samples, sensorMetadata }] of reports.entries()) {
      const report: IndicatorReport = { indicators, samples, sensorMetadata, mode: 'simulated', producer: `csv:${name}`, reportId: `${name}#${k}@${runId}`, dryRun };
      const res = await post<IndicatorReportResponse>('/device-api/indicators', report);
      if (!strongest || RANK.indexOf(res.decision) > RANK.indexOf(strongest)) strongest = res.decision;

      const values = indicators.map((i) => `${i.key} ${i.value?.toFixed(2) ?? '—'}${i.state === 'ok' ? '' : `(${i.state})`}`).join(' · ');
      console.log(`  t=${tPeak.toFixed(3)}s  ${res.decision} → ${res.action}${res.reason ? ` (${res.reason})` : ''}${res.incidentId ? `  사고 ${res.incidentId}` : ''}   ${values}`);
      if (brief) continue;
      for (const t of res.traces) {
        const inputs = Object.entries(t.inputs).map(([key, v]) => `${key}=${v?.toFixed(2) ?? '—'}`).join(' ');
        const limits = Object.entries(t.thresholds).map(([key, v]) => `${key}=${v}`).join(' ');
        console.log(`      [${t.fired ? '발동' : t.blocked_by ? '판정불가' : '미발동'}] ${t.rule}  ${inputs}  | ${limits}${t.blocked_by ? `  (${t.blocked_by})` : ''}`);
      }
    }
    summary.push({ run: name, decision: strongest });
  }
}

if (summary.length > 1) {
  console.log('\n실행별 가장 강한 판정');
  for (const { run, decision } of summary) console.log(`  ${run.padEnd(40)} ${decision ?? '보고 없음'}`);
}
