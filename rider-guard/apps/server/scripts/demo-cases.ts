/**
 * D6·B3·C3 데모. 기본은 합성 mock fixture, --esp32 면 ESP32·MPU6050 MOCK 기록(fixtures/esp32-mock)을 재생한다.
 * 기본은 오프라인으로 판정 결과만 출력한다.
 *
 *   node scripts/demo-cases.ts                      mock 판정 요약
 *   node scripts/demo-cases.ts --esp32              ESP32 MOCK D6·B3·C3 판정 요약 (A1 처럼 29조건 아무거나 지정 가능)
 *   node scripts/demo-cases.ts --esp32 --post C3    로컬 개발 서버(/me/indicators)로 보내 사고 기록을 만든다
 *     env: API_URL(기본 http://localhost:4000), RIDER_TOKEN(라이더 로그인 토큰, 운행 세션이 켜져 있어야 한다)
 *
 * 운영 서버는 mock·replay 보고로 사고를 만들지 않는다(not_live).
 * 개발 서버의 SMS·119 는 콘솔 어댑터라 실제로 아무에게도 연락하지 않는다.
 */
import type { SensorMetadata, SensorSample } from '@rider-guard/contract';

import { isEsp32CaseId, loadEsp32Case } from '../src/services/esp32-cases.ts';
import { MOCK_CASES, type MockCaseId } from '../src/services/mock-cases.ts';
import { analyzeImu } from '../src/services/sensor-analysis.ts';

type DemoCase = { title: string; expect: string; samples: SensorSample[]; sensorMetadata: SensorMetadata };

const args = process.argv.slice(2);
const esp32 = args.includes('--esp32');
const post = args.includes('--post');
const ids = args.filter((a) => !a.startsWith('--'));
const selected = ids.length ? ids : ['D6', 'B3', 'C3'];

function load(id: string): DemoCase {
  if (esp32) {
    if (!isEsp32CaseId(id)) throw new Error(`ESP32 기록에 없는 조건이에요: ${id}`);
    const c = loadEsp32Case(id);
    return { title: `${id} ${c.name} (ESP32 MOCK 1회차)`, expect: c.latchAt === null ? '기록 판정 후보 없음' : `기록 판정 첫 후보 ${c.latchAt}초`, samples: c.samples, sensorMetadata: c.sensorMetadata };
  }
  if (!(id in MOCK_CASES)) throw new Error(`mock fixture 는 D6·B3·C3 뿐이에요: ${id}`);
  return MOCK_CASES[id as MockCaseId]();
}

for (const id of selected) {
  const c = load(id);
  const a = analyzeImu(c.samples, c.sensorMetadata);
  console.log(`\n${c.title} — 기대: ${c.expect}`);
  console.log(`  판정 ${a.decision} · 최초 후보 ${a.candidateAt ?? '-'}초 · 규칙 ${a.ruleVersion} · 출처 ${a.metadata.dataSource}`);
  for (const e of a.evidence) console.log(`  ${e.key.padEnd(11)} 기준 ${e.threshold} ${e.unit} · 통과 ${e.value ?? '-'} @${e.passedAt ?? '-'} · 피크 ${e.peak ?? '-'} @${e.peakAt ?? '-'}`);
  console.log(`  품질: 누락 ${a.quality.missingPackets} · 시간 이상 ${a.quality.timeAnomalies} · ΔV 유효 ${a.quality.dvValid} (${a.quality.interval.valid}/${a.quality.interval.eligible}) ${a.quality.dvInvalidReasons.join(',')}`);

  if (post) {
    const api = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
    const token = process.env.RIDER_TOKEN;
    if (!token) throw new Error('RIDER_TOKEN 이 필요해요 (웹 앱 로그인 후 localStorage 의 토큰).');
    const res = await fetch(`${api}/me/indicators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: 'replay', producer: esp32 ? 'demo-cases:esp32' : 'demo-cases', reportId: `demo-${id}-${Date.now()}`, samples: c.samples, sensorMetadata: c.sensorMetadata }),
    });
    console.log(`  → POST ${res.status} ${await res.text()}`);
  }
}
