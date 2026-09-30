import type { Decision, Indicator, IndicatorKey, IndicatorUnits, RuleTrace } from '@rider-guard/contract';

/**
 * 지표 요약의 센서 시각으로 최근 0.5초를 평가한다. 원시 시계열은 sensor-analysis.ts가 담당한다.
 * 초기 보고서 규칙: 6g AND (300deg/s OR 유효한 DV 3m/s OR |bank| 45deg).
 * 무동작/주행 속도는 후보의 필수 조건이 아니다. 상해 등급이나 최적화된 기준을 뜻하지 않는다.
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
 * 요청된 초기값. stillQuietMinS는 기존 v1 라우터 기록 표시와의 호환용이며 새 후보 판정에 쓰지 않는다.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { impactGMin: 6, rotationDpsMin: 300, deltaVMin: 3, bankMinDeg: 45, stillQuietMinS: 20 };

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
  const options = indicators.filter((i) => i.key === key);
  const valid = options.filter((i) => i.state === 'ok' && i.value != null && Number.isFinite(i.value) && i.unit === INDICATOR_UNITS[key]);
  const m = valid.sort((a, b) => Math.abs(b.value!) - Math.abs(a.value!))[0] ?? options[0];
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
  const times = [...new Set(indicators.filter((i) => i.key !== 'quiet_s').map((i) => i.t).filter((t) => Number.isFinite(t) && t >= 0.15))].sort((a, b) => a - b);
  let result: ReturnType<typeof judgeWindow> | undefined;
  for (const t of times) {
    const window = indicators.filter((i) => i.t <= t && i.t >= t - 0.5 - 1e-9);
    const next = judgeWindow(window, th);
    if (next.decision === 'alarm') return next;
    // Separate timestamped support summaries do not erase a valid below-threshold acceleration observation.
    if (!result || !next.traces[0]!.blocked_by && (result.traces[0]!.blocked_by || next.decision === 'undetermined')) result = next;
  }
  return result ?? judgeWindow([], th);
}

function judgeWindow(indicators: Indicator[], th: Thresholds): { decision: Decision; traces: RuleTrace[] } {
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
  } else {
    // 무동작은 참고 지표이며 후보의 필수 조건이 아니다. 결측을 사고/정상으로 확정하지 않는다.
    decision = supportFired ? 'alarm' : 'undetermined';
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
