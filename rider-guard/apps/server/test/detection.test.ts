import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Indicator } from '@rider-guard/contract';

import { type ImuRow, parseImuCsv, reportsFromImu } from '../scripts/sim-indicators.ts';
import { judge, kindOf } from '../src/services/detection.ts';

const UNITS: Record<string, string> = { peak_g: 'g', peak_gyro: 'deg/s', delta_v150: 'm/s', bank_deg: 'deg', quiet_s: 's' };
const ind = (values: Record<string, number | null>): Indicator[] =>
  Object.entries(values).map(([key, value]) => ({ key, value, unit: UNITS[key] ?? null, state: value == null ? 'low_quality' : 'ok', sqi: null, t: 30 }));

// Mock summary fixtures inspired by prior reports; not measured validation. 가속도·각속도·ΔV 는 실행 전체 최대값이라
// 창 안 최대값보다 크거나 같다. 표에 기울기 열이 없어 0 으로 둔다 — 아래 실행은 기울기 없이도 판정이 갈린다.
// quiet_s 는 시뮬레이션이 30초를 다 보지 못해 없는 값이라, 쓰러진 채 가만히 있었다고 보고 25초로 둔다.
const RUNS = {
  A1_v00: { peak_g: 23.41, peak_gyro: 1366, delta_v150: 3.92 }, // 정지 승용차 측면 직각 충돌
  B2_v00: { peak_g: 21.5, peak_gyro: 1074, delta_v150: 7.49 }, //  정차 차량 후미 추돌
  C1_v00: { peak_g: 23.61, peak_gyro: 1353, delta_v150: 7.19 }, // 커브 저마찰 로우사이드
  C9_v00: { peak_g: 13.87, peak_gyro: 1058, delta_v150: 5.76 }, // 저속 균형 상실 전도
  D3_v09: { peak_g: 2.96, peak_gyro: 124, delta_v150: 1.8 }, //    과속방지턱 과속 통과 — 가장 센 실행
  D6_v09: { peak_g: 4.74, peak_gyro: 375, delta_v150: 2.86 }, //   연석 오르내리기 — 가장 센 실행
  D7_v03: { peak_g: 3.45, peak_gyro: 106, delta_v150: 0.61 }, //   요철 노면 — 가장 센 실행
};
const still = (run: keyof typeof RUNS) => ind({ ...RUNS[run], bank_deg: 0, quiet_s: 25 });

test('mock summary fixtures exercise the initial report thresholds', () => {
  const decisions = Object.fromEntries(Object.keys(RUNS).map((run) => [run, judge(still(run as keyof typeof RUNS)).decision]));
  assert.deepEqual(decisions, { A1_v00: 'alarm', B2_v00: 'alarm', C1_v00: 'alarm', C9_v00: 'alarm', D3_v09: 'reject', D6_v09: 'reject', D7_v03: 'reject' });
});

test('mock D6: 회전 조건은 통과해도 6g 미만이면 후보가 아니다', () => {
  const [impact, support] = judge(still('D6_v09')).traces;
  assert.equal(impact!.fired, false);
  assert.equal(support!.fired, true);
  assert.equal(support!.blocked_by, null);
});

test('mock A3: 새 초기값 300deg/s를 적용한다', () => {
  // A3_v03 stress_100hz: 11.76g, 434°/s, ΔV 2.77 — 후보가 서지 않았으니 기울기도 75° 미만이었다
  assert.equal(judge(ind({ peak_g: 11.76, peak_gyro: 434, delta_v150: 2.77, bank_deg: 0, quiet_s: 25 })).decision, 'alarm');
});

test('기울기만으로 선 후보는 넘어짐, 회전·ΔV 로 선 후보는 충격으로 연다', () => {
  assert.equal(kindOf(judge(ind({ peak_g: 6, peak_gyro: 200, delta_v150: 1, bank_deg: 85, quiet_s: 25 })).traces), 'fall');
  assert.equal(kindOf(judge(still('A1_v00')).traces), 'impact');
});

test('기울기는 좌우 상관없이 절댓값으로 본다', () => {
  assert.equal(judge(ind({ peak_g: 6, peak_gyro: 200, delta_v150: 1, bank_deg: -80, quiet_s: 25 })).decision, 'alarm');
});

test('후보 뒤 움직임으로 후보를 취소하지 않는다', () => {
  assert.equal(judge(ind({ ...RUNS.A1_v00, bank_deg: 0, quiet_s: 3 })).decision, 'alarm');
});

test('후보는 확실한데 무동작을 못 재면 경보한다 — 놓침은 되돌릴 수 없다 (1.3)', () => {
  const { decision, traces } = judge(ind({ ...RUNS.A1_v00, bank_deg: 0, quiet_s: null }));
  assert.equal(decision, 'alarm');
  assert.equal(traces.find((t) => t.rule === 'post_still')!.blocked_by, 'low_quality:quiet_s');
});

test('보조 지표가 없으면 무동작과 무관하게 정보 부족', () => {
  const onlyImpact = (quiet_s: number) => [...ind({ peak_g: 10, quiet_s }), { key: 'peak_gyro', value: 12, unit: 'rad/s', state: 'ok' as const, sqi: null, t: 30 }];
  const { decision, traces } = judge(onlyImpact(25));
  assert.equal(decision, 'undetermined');
  assert.equal(traces.find((t) => t.rule === 'support')!.blocked_by, 'unit:peak_gyro(rad/s≠deg/s),missing:delta_v150,missing:bank_deg');
  assert.equal(judge(onlyImpact(2)).decision, 'undetermined');
});

test('보조 하나만 서면 나머지가 비어 있어도 상관없다', () => {
  const { decision, traces } = judge(ind({ peak_g: 10, delta_v150: 4, quiet_s: 25 }));
  assert.equal(decision, 'alarm');
  assert.equal(traces.find((t) => t.rule === 'support')!.blocked_by, null);
});

test('충격 지표가 없으면 판정 불가, 0 으로 메우지 않는다', () => {
  const { decision, traces } = judge(ind({ peak_gyro: 900, quiet_s: 25 }));
  assert.equal(decision, 'undetermined');
  assert.equal(traces.find((t) => t.rule === 'impact')!.inputs.peak_g, null);
});

// ── 시뮬레이션 IMU → 지표 보고 ─────────────────────────────────

/** 100Hz 합성 신호. t=0.05 초기 튐, t=1 방지턱 3.5g, t=5 충돌 12g(각속도 900°/s 는 0.3초 뒤, 88° 기울기는 1초 뒤), 7초부터 가만히 */
function syntheticRide(end: number): ImuRow[] {
  const rows: ImuRow[] = [];
  for (let i = 0; i <= end * 100; i++) {
    const t = i / 100;
    const near = (at: number) => Math.abs(t - at) < 0.005;
    rows.push({
      t,
      accG: near(0.05) ? 30 : near(1) ? 3.5 : near(5) ? 12 : t > 5 && t < 7 ? 1.6 : 1,
      gyroDps: near(0.05) ? 2000 : near(1) ? 100 : near(5.3) ? 900 : t > 5 && t < 7 ? 50 : 2,
      bankDeg: t >= 6 ? 88 : 5,
      dv150: t < 0.15 ? NaN : near(5.1) ? 2.5 : 0.3,
    });
  }
  return rows;
}

test('3g 이벤트마다 보고 하나, 보조 지표는 충격 최대 시각 앞뒤 0.5초 안의 최대값이다', () => {
  const reports = reportsFromImu(syntheticRide(40));
  assert.deepEqual(reports.map((r) => r.tPeak), [1, 5]); // 초기 유예(0.15초) 안의 30g 는 이벤트가 아니다
  const crash = Object.fromEntries(reports[1]!.indicators.map((i) => [i.key, i.value]));
  // 1초 뒤의 88° 기울기는 창 밖이라 묶지 않는다 — 기록 전체 최대값을 쓰면 서로 다른 순간이 한 사고가 된다
  assert.deepEqual(crash, { peak_g: 12, peak_gyro: 900, delta_v150: 2.5, bank_deg: 5, quiet_s: 28 });
  assert.equal(judge(reports[0]!.indicators).decision, 'reject');
  assert.equal(judge(reports[1]!.indicators).decision, 'alarm');
});

test('0.5초 넘게 떨어진 두 충격은 창도 둘이다 — 추돌 직후 회전을 뒤의 더 큰 충격 창에 묻지 않는다 (B3)', () => {
  // B3 기본 조건 모양: 1.5초 추돌 15g 직후 1000°/s 회전, 0.8초 뒤 머리를 한 번 더 부딪쳐 22g (회전은 작다)
  const rows = syntheticRide(40).map((r) => {
    const near = (at: number) => Math.abs(r.t - at) < 0.005;
    return { ...r, accG: near(1) ? 1 : near(5) ? 1 : near(1.5) ? 15 : near(2.3) ? 22 : r.accG, gyroDps: near(1.55) ? 1000 : near(5.3) ? 2 : r.gyroDps };
  });
  const reports = reportsFromImu(rows);
  assert.deepEqual(reports.map((r) => r.tPeak), [1.5, 2.3]);
  assert.deepEqual(reports.map((r) => r.analysis.decision), ['candidate', 'no_candidate']);
});

test('30초를 다 보지 못한 기록은 quiet_s 를 품질 미달로 보낸다', () => {
  const [, crash] = reportsFromImu(syntheticRide(8));
  const quiet = crash!.indicators.find((i) => i.key === 'quiet_s')!;
  assert.equal(quiet.state, 'low_quality');
  assert.equal(quiet.value, 1);
  assert.equal(judge(crash!.indicators).decision, 'alarm');
});

test('3g 를 넘지 않은 기록은 보낼 것이 없다', () => {
  assert.deepEqual(reportsFromImu(syntheticRide(40).map((r) => ({ ...r, accG: Math.min(r.accG, 2.9) }))), []);
});

test('팀 telemetry 출력은 실행별로, 발표 자료 프로파일은 한 실행으로 읽는다', () => {
  const team = [
    'run_id,scenario_id,t_s,imu_acc_norm_g,imu_gyro_norm_dps,imu_bank_est_deg,imu_delta_v150_mps,tag_vx',
    'r1,D6,0.001,1,0,0,,13',
    'r1,D6,0.002,1,0,0,0.1,13',
    'r2,A1,0.001,1,0,0,,13',
  ].join('\n');
  assert.deepEqual([...parseImuCsv(team).keys()], ['D6:r1', 'A1:r2']);

  const profile = parseImuCsv('﻿t_s,acc_norm_g,gyro_norm_dps,bank_est_deg,delta_v150_mps\n0.005,1,0,0,nan\n0.01,1,0,0,0.2');
  const rows = profile.get(null)!;
  assert.ok(Number.isNaN(rows[0]!.dv150));
  assert.equal(rows[1]!.dv150, 0.2);
});

test('필요한 열이 없는 CSV 는 이유를 말하고 거절한다 — 실제 속도만 있는 옛 형식도', () => {
  assert.throws(() => parseImuCsv('t,ax,ay,az,vx,vy,vz\n0,0,0,0,0,0,0'), /열이 없어요: t_s/);
});
