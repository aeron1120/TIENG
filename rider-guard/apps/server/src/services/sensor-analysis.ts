import type { SensorAnalysis, SensorMetadata, SensorMetricEvidence, SensorSample, Vector3 } from '@rider-guard/contract';

export type SensorRule = { version: string; windowS: number; dvWindowS: number; warmupS: number; g: number; gyro: number; dv: number; bank: number };
/** 운영 규칙 — 보고서 초기값. 사고 판정에 쓰는 것은 이것뿐이다 */
export const SENSOR_RULE = { version: 'imu-report-v1', windowS: 0.5, dvWindowS: 0.15, warmupS: 0.15, g: 6, gyro: 300, dv: 3, bank: 45 } as const satisfies SensorRule;
/**
 * 발표자료 초안의 기준(4g·600°/s·75°). 출처 문서가 달라 비교 화면에서만 나란히 보여 준다 — 사고를 열지 않는다.
 * ΔV 기준은 초안에 없어 운영 규칙과 같은 3 m/s 로 둔다.
 */
export const PPT_DRAFT_RULE = { ...SENSOR_RULE, version: 'ppt-draft-4g-600dps-75deg', g: 4, gyro: 600, bank: 75 } as const satisfies SensorRule;
const EPS = 1e-9;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const value = (n: unknown) => finite(n) ? n : null;
type Point = SensorAnalysis['waveform'][number] & { reasons: string[]; validTime: boolean; linear: Vector3 | null };

// Specific force is rotated to the world frame before removing gravity. Quaternion [w,x,y,z].
function linearAcceleration(s: SensorSample): Vector3 | null {
  if (!s.accelMps2?.every(finite) || !s.orientation?.every(finite)) return null;
  const norm = Math.hypot(...s.orientation);
  if (norm < EPS) return null;
  const [w, x, y, z] = s.orientation.map((n) => n / norm);
  const [a, b, c] = s.accelMps2;
  return [
    (1 - 2 * (y*y + z*z))*a + 2*(x*y - z*w)*b + 2*(x*z + y*w)*c,
    2*(x*y + z*w)*a + (1 - 2*(x*x + z*z))*b + 2*(y*z - x*w)*c,
    2*(x*z - y*w)*a + 2*(y*z + x*w)*b + (1 - 2*(x*x + y*y))*c - 9.80665,
  ];
}

function integrate(points: Point[], end: number, dvWindowS: number): { dv: number | null; reason?: string } {
  const to = points[end].t, from = to - dvWindowS;
  if (from < -EPS || points[0].t > from + EPS) return { dv: null, reason: 'history_short' };
  let start = end;
  while (start > 0 && points[start].t > from + EPS) start--;
  if (points[start].t > from + EPS) return { dv: null, reason: 'history_short' };
  const total: Vector3 = [0, 0, 0];
  for (let i = start + 1; i <= end; i++) {
    const prev = points[i - 1], next = points[i];
    if (next.gap || !next.validTime || !prev.validTime) return { dv: null, reason: next.reasons[0] ?? 'time_anomaly' };
    if (!prev.linear || !next.linear) return { dv: null, reason: 'missing_orientation_or_acceleration' };
    const left = Math.max(from, prev.t), dt = next.t - prev.t;
    if (dt <= 0) return { dv: null, reason: 'time_anomaly' };
    // Only a complete, contiguous measured segment is integrated. No gap interpolation.
    const fraction = (left - prev.t) / dt;
    for (let axis = 0; axis < 3; axis++) {
      const initial = prev.linear[axis] + (next.linear[axis] - prev.linear[axis]) * fraction;
      total[axis] += (initial + next.linear[axis]) * 0.5 * (next.t - left);
    }
  }
  return { dv: Math.hypot(...total) };
}

/** Input order is retained: sorting would hide clock resets and duplicate timestamps. */
export function analyzeImu(samples: SensorSample[], metadata: SensorMetadata = { dataSource: 'mock' }, rule: SensorRule = SENSOR_RULE): SensorAnalysis {
  const points: Point[] = [];
  let missingPackets = 0, timeAnomalies = 0, lastTime = -Infinity;
  const saturation: SensorAnalysis['quality']['saturation'] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], prev = samples[i - 1];
    const reasons: string[] = [];
    const validTime = finite(s.t) && s.t >= 0 && s.t > lastTime;
    if (!validTime) { timeAnomalies++; reasons.push('time_anomaly'); }
    if (finite(s.t)) lastTime = Math.max(lastTime, s.t);
    if (prev && finite(s.seq) && finite(prev.seq) && s.seq !== prev.seq + 1) {
      missingPackets += Math.max(0, s.seq - prev.seq - 1);
      reasons.push('packet_gap');
    }
    if (prev && metadata.sampleRateHz && s.t - prev.t > 1.5 / metadata.sampleRateHz + EPS) reasons.push('sample_gap');
    const accAxes = (s.rawAcc ?? []).flatMap((n, axis) => Math.abs(n) >= 32760 ? [axis] : []);
    const gyroAxes = (s.rawGyro ?? []).flatMap((n, axis) => Math.abs(n) >= 32760 ? [axis] : []);
    if (accAxes.length || gyroAxes.length) saturation.push({ t: s.t, accAxes, gyroAxes });
    const p: Point = { t: s.t, accG: value(s.accG), gyroDps: value(s.gyroDps), bankDeg: value(s.bankDeg), dv150: null,
      gap: reasons.length > 0, saturated: !!(accAxes.length || gyroAxes.length), reasons, validTime, linear: linearAcceleration(s) };
    points.push(p);
    // Explicit upstream invalidation has priority over a supplied numeric summary.
    if (s.dvValid === false) p.reasons.push(s.dvInvalidReason ?? 'upstream_invalid');
    else if (finite(s.dv150)) {
      const bad = points.some((v) => v.t > s.t - rule.dvWindowS + EPS && v.t <= s.t && v.gap);
      if (bad) p.reasons.push('packet_or_time_gap'); else p.dv150 = s.dv150;
    } else if (s.accelMps2) {
      const result = integrate(points, i, rule.dvWindowS);
      p.dv150 = result.dv;
      if (result.reason) p.reasons.push(result.reason);
    } else p.reasons.push(s.dvInvalidReason ?? 'missing_dv');
    if (s.t < rule.warmupS - EPS) { p.dv150 = null; p.reasons.push('history_short'); }
  }
  let candidateAt: number | null = null;
  let insufficient = false, evaluated = false;
  let trigger: Point[] = [];
  for (const p of points) {
    if (!p.validTime || p.t < rule.warmupS - EPS) continue;
    evaluated = true;
    const window = points.filter((v) => v.validTime && v.t <= p.t && v.t >= p.t - rule.windowS - EPS);
    const impact = window.some((v) => v.accG !== null && v.accG >= rule.g);
    const support = window.some((v) => (v.gyroDps !== null && v.gyroDps >= rule.gyro) || (v.dv150 !== null && v.dv150 >= rule.dv - EPS) || (v.bankDeg !== null && Math.abs(v.bankDeg) >= rule.bank));
    if (impact && support) { candidateAt = p.t; trigger = window; break; }
    if (window.some((v) => v.accG === null || v.gap) || (impact && window.some((v) => v.gyroDps === null || v.bankDeg === null || v.dv150 === null))) insufficient = true;
  }
  const validPoints = points.filter((p) => p.validTime);
  const from = candidateAt === null ? (validPoints[0]?.t ?? 0) : Math.max(0, candidateAt - rule.windowS);
  const to = candidateAt === null ? (validPoints.at(-1)?.t ?? from) : Math.min(validPoints.at(-1)?.t ?? candidateAt, candidateAt + rule.windowS);
  const event = validPoints.filter((p) => p.t >= from - EPS && p.t <= to + EPS);
  const metrics = [
    ['peak_g', 'g', 'accG', rule.g], ['peak_gyro', 'deg/s', 'gyroDps', rule.gyro],
    ['delta_v150', 'm/s', 'dv150', rule.dv], ['bank_deg', 'deg', 'bankDeg', rule.bank],
  ] as const;
  const evidence: SensorMetricEvidence[] = metrics.map(([key, unit, field, threshold]) => {
    const magnitude = (p: Point) => p[field] === null ? null : Math.abs(p[field]!);
    const passed = trigger.find((p) => magnitude(p) !== null && magnitude(p)! >= threshold - EPS);
    const peak = event.reduce<Point | null>((best, p) => magnitude(p) !== null && (best === null || magnitude(p)! > magnitude(best)!) ? p : best, null);
    return { key, unit, threshold, value: passed ? magnitude(passed) : null, passedAt: passed?.t ?? null, peak: peak ? magnitude(peak) : null, peakAt: peak?.t ?? null };
  });
  const eligible = event.filter((p) => p.t >= rule.warmupS - EPS);
  const valid = eligible.filter((p) => p.dv150 !== null).length;
  return {
    ruleVersion: rule.version, decision: candidateAt !== null ? 'candidate' : !evaluated || insufficient ? 'insufficient' : 'no_candidate',
    candidateAt, windowS: rule.windowS, dvWindowS: rule.dvWindowS, warmupS: rule.warmupS, metadata, evidence,
    quality: { missingPackets, timeAnomalies, sequenceAvailable: samples.length > 0 && samples.every((s) => finite(s.seq)),
      // 사유도 비율과 같은 구간(판정 시작 이후)만 — 150ms 이전 표본의 history_short 를 무효 사유로 섞지 않는다
      dvValid: eligible.length > 0 && valid === eligible.length, dvInvalidReasons: [...new Set(eligible.flatMap((p) => p.dv150 === null ? p.reasons : []))],
      dvValidRatio: eligible.length ? valid / eligible.length : null, interval: { from, to, eligible: eligible.length, valid }, saturation },
    waveform: points.map(({ reasons: _reasons, validTime: _validTime, linear: _linear, ...p }) => p),
  };
}
