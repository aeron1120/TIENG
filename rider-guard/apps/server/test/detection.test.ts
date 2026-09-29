import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Indicator } from '@rider-guard/contract';

import { indicatorsFromSim, parseSimCsv, type SimRow } from '../scripts/sim-indicators.ts';
import { judge, kindOf } from '../src/services/detection.ts';

const UNITS: Record<string, string> = { delta_v: 'm/s', tilt_deg: 'deg', speed: 'm/s', accel_var_1s: 'm/s^2' };
const ind = (values: Record<string, number | null>): Indicator[] =>
  Object.entries(values).map(([key, value]) => ({ key, value, unit: UNITS[key] ?? null, state: value == null ? 'low_quality' : 'ok', sqi: null, t: 5 }));

// 시뮬레이션 네 시나리오를 닮은 지표. 값은 설계상 기대 모양이지 시뮬레이션 실측이 아니다.
const SCENARIOS = {
  '1_lowside (40° 기운 채 균형 제어 해제)': { delta_v: 2.1, tilt_deg: 88, speed: 0.2, accel_var_1s: 0.05 },
  '2_frontal (30km/h 정차 차량 충돌)': { delta_v: 7.4, tilt_deg: 84, speed: 0.1, accel_var_1s: 0.04 },
  '3_speedbump (20km/h 방지턱)': { delta_v: 1.3, tilt_deg: 6, speed: 5.4, accel_var_1s: 2.2 },
  '4_hardbrake (30km/h 급제동)': { delta_v: 0.6, tilt_deg: 9, speed: 0.0, accel_var_1s: 0.05 },
};

test('사고 2종은 경보, 정상 주행 2종은 기각', () => {
  const decisions = Object.fromEntries(Object.entries(SCENARIOS).map(([name, v]) => [name.split(' ')[0], judge(ind(v)).decision]));
  assert.deepEqual(decisions, { '1_lowside': 'alarm', '2_frontal': 'alarm', '3_speedbump': 'reject', '4_hardbrake': 'reject' });
});

test('로우사이드는 넘어짐, 정면 충돌은 충격으로 연다', () => {
  assert.equal(kindOf(judge(ind(SCENARIOS['1_lowside (40° 기운 채 균형 제어 해제)'])).traces), 'fall');
  assert.equal(kindOf(judge(ind(SCENARIOS['2_frontal (30km/h 정차 차량 충돌)'])).traces), 'impact');
});

test('충격 뒤 계속 움직이면 기각 — 특이도는 충격 이후에서 나온다 (2.3)', () => {
  assert.equal(judge(ind({ delta_v: 5, tilt_deg: 10, speed: 4, accel_var_1s: 1.5 })).decision, 'reject');
});

test('충격은 확실한데 무동작을 못 재면 경보한다 — 놓침은 되돌릴 수 없다 (1.3)', () => {
  const { decision, traces } = judge(ind({ delta_v: 5, tilt_deg: 10, speed: null, accel_var_1s: 0.1 }));
  assert.equal(decision, 'alarm_unverified');
  assert.equal(traces.find((t) => t.rule === 'post_still')!.blocked_by, 'low_quality:speed');
});

test('충격·전도 지표가 둘 다 없으면 판정 불가, 0 으로 메우지 않는다', () => {
  const { decision, traces } = judge(ind({ speed: 0, accel_var_1s: 0 }));
  assert.equal(decision, 'undetermined');
  assert.equal(traces.find((t) => t.rule === 'impact')!.inputs.delta_v, null);
});

test('단위가 다르면 비교하지 않고 판정 불가로 둔다', () => {
  const indicators = ind({ delta_v: 1, speed: 0, accel_var_1s: 0 });
  indicators.push({ key: 'tilt_deg', value: 1.5, unit: 'rad', state: 'ok', sqi: null, t: 5 });
  const fall = judge(indicators).traces.find((t) => t.rule === 'fall_posture')!;
  assert.equal(fall.fired, false);
  assert.match(fall.blocked_by!, /^unit:tilt_deg/);
});

// ── MuJoCo CSV → 지표 ──────────────────────────────────────────

/** 2000Hz, 8 m/s 로 가다가 t=1.0 에서 50ms 만에 멈추고 넘어진 채 가만히 있는 합성 신호 */
function syntheticCrash(): SimRow[] {
  const rows: SimRow[] = [];
  for (let i = 0; i <= 5000; i++) {
    const t = i / 2000;
    const v = t < 1 ? 8 : t < 1.05 ? 8 * (1 - (t - 1) / 0.05) : 0;
    const braking = t >= 1 && t < 1.05;
    rows.push({
      t,
      // 처음 0.15초 안의 큰 값은 초기 안정화라 무시돼야 한다
      ax: t < 0.01 ? 500 : braking ? -160 : 0,
      ay: 0,
      az: 9.81,
      gx: braking ? 6 : 0,
      gy: 0,
      gz: 0,
      vx: t < 0.01 ? 30 : v,
      vy: 0,
      vz: 0,
      com_vx: v,
      com_vy: 0,
      com_vz: 0,
      tilt_deg: t < 1.05 ? 5 : 88,
    });
  }
  return rows;
}

test('시뮬레이션 CSV 에서 보고서 5절 정의대로 지표를 뽑는다', () => {
  const header = 't,ax,ay,az,gx,gy,gz,vx,vy,vz,com_vx,com_vy,com_vz,tilt_deg';
  const csv = [header, ...syntheticCrash().map((r) => Object.values(r).join(','))].join('\n');
  const values = Object.fromEntries(indicatorsFromSim(parseSimCsv(csv)).map((i) => [i.key, i.value]));

  assert.ok(Math.abs(values.delta_v! - 8) < 1e-9, `delta_v ${values.delta_v}`); // 100ms 안에 8 → 0, 초기 30 m/s 는 제외
  assert.ok(Math.abs(values.delta_v_com! - 8) < 1e-9);
  assert.ok(Math.abs(values.peak_g! - Math.hypot(160, 9.81) / 9.81) < 1e-9, `peak_g ${values.peak_g}`); // 초기 500 은 제외
  assert.equal(values.peak_gyro, 6);
  assert.equal(values.tilt_deg, 88);
  assert.equal(values.speed, 0);
  assert.ok(values.accel_var_1s! < 1e-9);

  assert.equal(judge(indicatorsFromSim(syntheticCrash())).decision, 'alarm');
});

test('필요한 열이 없는 CSV 는 이유를 말하고 거절한다', () => {
  assert.throws(() => parseSimCsv('t,ax,ay\n0,0,0'), /열이 없어요: az/);
});
