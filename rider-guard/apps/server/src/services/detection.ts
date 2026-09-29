import type { Decision, Indicator, IndicatorKey, IndicatorUnits, RuleTrace } from '@rider-guard/contract';

/**
 * 지표 → 판정. 설계문서 5.1 흐름을 그대로 옮긴다.
 *
 *   충격(ΔV) 또는 전도(몸통 기울기)  →  사후 무동작(속도·가속도 변동)  →  경보
 *
 * 앞 단계는 놓치지 않는 쪽(민감도), 뒤 단계는 헛경보를 거르는 쪽(특이도)이다 (2.3 — 특이도는 '충격 이후'에서 나온다).
 * 순수 함수다. 시계를 읽거나 I/O 를 하지 않으므로 같은 지표면 언제 돌려도 같은 판정이 나온다 — 시뮬레이션 결과로
 * 임계값을 맞출 때 이 성질이 필요하다.
 */

export type Thresholds = {
  /** 충격: 태그 100ms ΔV (m/s). 피크 가속도는 부착 강성에 흔들려 ΔV 를 중심에 둔다 (5.2) */
  deltaVMin: number;
  /** 전도: 몸통 기울기 (deg). 60° 이상 (5.3) */
  tiltMinDeg: number;
  /** 무동작: 마지막 1초 가속도 크기 표준편차 상한 (m/s^2) (5.4) */
  stillAccelVarMax: number;
  /** 무동작: 속도 상한 (m/s). 3 km/h */
  stillSpeedMax: number;
};

/** 전부 추정치다. 시뮬레이션·Phase 1 실측으로 다시 정한다 (설계문서 11장 '초기 임계값 세트'). */
export const DEFAULT_THRESHOLDS: Thresholds = { deltaVMin: 3.33, tiltMinDeg: 60, stillAccelVarMax: 0.3, stillSpeedMax: 0.83 };

export const INDICATOR_UNITS: IndicatorUnits = {
  delta_v: 'm/s',
  delta_v_com: 'm/s',
  peak_g: 'g',
  peak_g_phone: 'g',
  peak_gyro: 'rad/s',
  tilt_deg: 'deg',
  speed: 'm/s',
  accel_var_1s: 'm/s^2',
};

type Read = { value: number } | { blocked: string };

/** 믿을 수 있는 값만 쓴다. 없거나 품질 미달이거나 단위가 다르면 '판정 불가' 사유를 돌려준다 — 0 으로 메우지 않는다. */
function read(indicators: Indicator[], key: IndicatorKey): Read {
  const m = indicators.find((i) => i.key === key);
  if (!m) return { blocked: `missing:${key}` };
  if (m.state !== 'ok') return { blocked: `${m.state}:${key}` };
  if (m.value == null || !Number.isFinite(m.value)) return { blocked: `no_value:${key}` };
  if (m.unit !== INDICATOR_UNITS[key]) return { blocked: `unit:${key}(${m.unit ?? '-'}≠${INDICATOR_UNITS[key]})` };
  return { value: m.value };
}

const valueOf = (r: Read) => ('value' in r ? r.value : null);
const blockedOf = (...rs: Read[]) => rs.map((r) => ('blocked' in r ? r.blocked : null)).filter(Boolean).join(',') || null;

export function judge(indicators: Indicator[], th: Thresholds = DEFAULT_THRESHOLDS): { decision: Decision; traces: RuleTrace[] } {
  const dv = read(indicators, 'delta_v');
  const tilt = read(indicators, 'tilt_deg');
  const speed = read(indicators, 'speed');
  const accelVar = read(indicators, 'accel_var_1s');

  const impactFired = 'value' in dv && dv.value >= th.deltaVMin;
  const fallFired = 'value' in tilt && tilt.value >= th.tiltMinDeg;
  const stillBlocked = blockedOf(speed, accelVar);
  const stillFired = !stillBlocked && valueOf(speed)! <= th.stillSpeedMax && valueOf(accelVar)! <= th.stillAccelVarMax;

  const traces: RuleTrace[] = [
    { rule: 'impact', fired: impactFired, inputs: { delta_v: valueOf(dv) }, thresholds: { delta_v_min: th.deltaVMin }, blocked_by: blockedOf(dv) },
    { rule: 'fall_posture', fired: fallFired, inputs: { tilt_deg: valueOf(tilt) }, thresholds: { tilt_min_deg: th.tiltMinDeg }, blocked_by: blockedOf(tilt) },
    {
      rule: 'post_still',
      fired: stillFired,
      inputs: { speed: valueOf(speed), accel_var_1s: valueOf(accelVar) },
      thresholds: { speed_max: th.stillSpeedMax, accel_var_max: th.stillAccelVarMax },
      blocked_by: stillBlocked,
    },
  ];

  let decision: Decision;
  if (impactFired || fallFired) {
    // 충격·전도가 있었는데 무동작을 확인할 수 없으면 경보한다. 놓침은 되돌릴 수 없고(1.3),
    // 헛경보는 라이더가 카운트다운에서 한 번 눌러 끝낼 수 있다.
    decision = stillFired ? 'alarm' : stillBlocked ? 'alarm_unverified' : 'reject';
  } else if ('blocked' in dv && 'blocked' in tilt) {
    decision = 'undetermined';
  } else {
    decision = 'reject';
  }
  return { decision, traces };
}

export const isAlarm = (d: Decision) => d === 'alarm' || d === 'alarm_unverified';

/** 사고 종류: 충격이 섰으면 충격, 충격 없이 기울기만 섰으면 넘어짐(로우사이드처럼 미끄러져 눕는 경우) */
export const kindOf = (traces: RuleTrace[]) =>
  traces.find((t) => t.rule === 'impact')?.fired || !traces.find((t) => t.rule === 'fall_posture')?.fired ? 'impact' : 'fall';
