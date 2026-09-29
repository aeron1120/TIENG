import type { Decision, Indicator, IndicatorKey, IndicatorUnits, RuleTrace } from '@rider-guard/contract';

/**
 * 지표 → 판정. 설계문서 5.1 흐름에 헬멧 IMU 실험(2026-09-28)이 고른 사고 후보 규칙을 앞 단계로 넣는다.
 *
 *   충격(가속도) AND 보조(각속도 OR ΔV OR 기울기)  →  사후 무동작(30초 관찰)  →  경보
 *
 * 앞 단계는 놓치지 않는 쪽(민감도), 뒤 단계는 헛경보를 거르는 쪽(특이도)이다 (2.3 — 특이도는 '충격 이후'에서 나온다).
 * 앞 단계는 시뮬레이션에서만 고른 값이고 뒤 단계는 아직 어떤 데이터로도 맞추지 않았다.
 * 순수 함수다. 시계를 읽거나 I/O 를 하지 않으므로 같은 지표면 언제 돌려도 같은 판정이 나온다 — 시뮬레이션 결과로
 * 임계값을 맞출 때 이 성질이 필요하다.
 */

export type Thresholds = {
  /** 충격: 헬멧 합성 가속도 (g) */
  impactGMin: number;
  /** 보조: 헬멧 합성 각속도 (deg/s) */
  rotationDpsMin: number;
  /** 보조: IMU 추정 150ms ΔV (m/s) */
  deltaVMin: number;
  /** 보조: IMU 추정 헬멧 기울기 절댓값 (deg) */
  bankMinDeg: number;
  /** 무동작: 보고 시각(충격 30초 뒤)까지 이어진 무동작 시간 하한 (s) */
  stillQuietMinS: number;
};

/**
 * 앞 네 값은 실험이 nominal_200hz calibration 145회에서 고정한 값이다 (analysis/locked_thresholds.json).
 * 실측 데이터가 0건이라 실도로 기준은 아니다. 무동작 20초는 30초 관찰 중 처음 10초를 미끄러짐·구름이 멎는 여유로 둔 값이다
 * (시뮬레이션에서 첫 충돌 → 마지막 움직임은 최대 2.9초).
 */
export const DEFAULT_THRESHOLDS: Thresholds = { impactGMin: 4, rotationDpsMin: 600, deltaVMin: 3, bankMinDeg: 75, stillQuietMinS: 20 };

export const INDICATOR_UNITS: IndicatorUnits = {
  peak_g: 'g',
  peak_gyro: 'deg/s',
  delta_v150: 'm/s',
  bank_deg: 'deg',
  quiet_s: 's',
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
const atLeast = (r: Read, min: number) => 'value' in r && r.value >= min;

export function judge(indicators: Indicator[], th: Thresholds = DEFAULT_THRESHOLDS): { decision: Decision; traces: RuleTrace[] } {
  const g = read(indicators, 'peak_g');
  const gyro = read(indicators, 'peak_gyro');
  const dv = read(indicators, 'delta_v150');
  const bank = read(indicators, 'bank_deg');
  const quiet = read(indicators, 'quiet_s');
  const bankAbs: Read = 'value' in bank ? { value: Math.abs(bank.value) } : bank;

  const impactFired = atLeast(g, th.impactGMin);
  const supportFired = atLeast(gyro, th.rotationDpsMin) || atLeast(dv, th.deltaVMin) || atLeast(bankAbs, th.bankMinDeg);
  // 하나라도 섰으면 나머지가 비어도 상관없다. 아무것도 안 섰는데 빈 게 있으면 기각이 아니라 판정 불가다.
  const supportBlocked = supportFired ? null : blockedOf(gyro, dv, bank);
  const stillBlocked = blockedOf(quiet);
  const stillFired = atLeast(quiet, th.stillQuietMinS);

  const traces: RuleTrace[] = [
    { rule: 'impact', fired: impactFired, inputs: { peak_g: valueOf(g) }, thresholds: { impact_g_min: th.impactGMin }, blocked_by: blockedOf(g) },
    {
      rule: 'support',
      fired: supportFired,
      inputs: { peak_gyro: valueOf(gyro), delta_v150: valueOf(dv), bank_deg: valueOf(bankAbs) },
      thresholds: { rotation_dps_min: th.rotationDpsMin, delta_v_min: th.deltaVMin, bank_min_deg: th.bankMinDeg },
      blocked_by: supportBlocked,
    },
    { rule: 'post_still', fired: stillFired, inputs: { quiet_s: valueOf(quiet) }, thresholds: { quiet_min_s: th.stillQuietMinS }, blocked_by: stillBlocked },
  ];

  let decision: Decision;
  if ('blocked' in g) {
    decision = 'undetermined';
  } else if (!impactFired || (!supportFired && !supportBlocked)) {
    decision = 'reject';
  } else if (!stillFired && !stillBlocked) {
    // 후보 뒤 계속 움직였다 — 보조 조건을 확인 못 했어도 기각한다.
    decision = 'reject';
  } else {
    // 충격이 섰는데 보조 조건이나 무동작을 확인할 수 없으면 경보한다. 놓침은 되돌릴 수 없고(1.3),
    // 헛경보는 라이더가 카운트다운에서 한 번 눌러 끝낼 수 있다.
    decision = supportFired && stillFired ? 'alarm' : 'alarm_unverified';
  }
  return { decision, traces };
}

export const isAlarm = (d: Decision) => d === 'alarm' || d === 'alarm_unverified';

/** 사고 종류: 회전이나 속도 급변이 섰으면 충격, 기울기만으로 섰으면 넘어짐. 시뮬레이션으로 검증한 구분은 아니고 알림 문구용이다. */
export function kindOf(traces: RuleTrace[]): 'impact' | 'fall' {
  const support = traces.find((t) => t.rule === 'support');
  if (!support?.fired) return 'impact';
  const { peak_gyro, delta_v150 } = support.inputs;
  const { rotation_dps_min, delta_v_min } = support.thresholds;
  const moved = (peak_gyro ?? -Infinity) >= rotation_dps_min! || (delta_v150 ?? -Infinity) >= delta_v_min!;
  return moved ? 'impact' : 'fall';
}
