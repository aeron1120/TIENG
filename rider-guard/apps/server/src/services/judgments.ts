import type { IndicatorReport, IndicatorReportResponse, OpsJudgmentDto } from '@rider-guard/contract';

import type { AppContext, IncidentRow } from '../context.ts';
import { ApiError, iso, newId } from '../lib.ts';
import { isAlarm, judge, kindOf } from './detection.ts';
import { createIncident } from './incidents.ts';
import { activeSession } from './sessions.ts';
import { analyzeImu, SENSOR_RULE } from './sensor-analysis.ts';
import { consentsOf } from './riders.ts';

/**
 * 지표 보고 하나를 판정하고, 경보면 사고를 연다. 판정은 결과와 상관없이 전부 기록한다.
 *
 * 경보여도 사고를 열지 않는 경우 — 이유를 reason 에 남긴다:
 *   not_paired          어느 라이더의 기기인지 모른다
 *   detection_disabled  Phase 1 (기록만, DETECTION_ENABLED)
 *   not_live            운영 서버에 시뮬레이션·리플레이 지표가 들어왔다 — 합성 값으로 실제 연락처를 깨우지 않는다
 *   no_active_session   운행 중이 아니다 (5.5 '일상 동작'은 오탐)
 *   stale_event         감지 시각이 10분 넘게 지났다
 */
export async function receiveIndicators(
  ctx: AppContext,
  from: { riderId: string | null; deviceId: string | null; via: 'device' | 'phone'; /** 휴대폰 자체 센서가 보낸 구간 */ phoneImu?: boolean },
  report: IndicatorReport,
): Promise<IndicatorReportResponse> {
  const analysis = report.samples ? analyzeImu(report.samples, report.sensorMetadata ?? { dataSource: 'mock' }) : null;
  const indicators = analysis ? analysis.evidence.map((e) => ({ key: e.key, value: e.value ?? e.peak, unit: e.unit, state: (e.value ?? e.peak) === null ? 'low_quality' as const : 'ok' as const, sqi: null, t: e.passedAt ?? e.peakAt ?? 0 })) : report.indicators;
  const judged = judge(indicators, ctx.config.thresholds);
  const decision = analysis ? analysis.decision === 'candidate' ? 'alarm' : analysis.decision === 'insufficient' ? 'undetermined' : 'reject' : judged.decision;
  const traces = judged.traces;
  if (report.dryRun) return { decision, traces, action: 'dry_run', reason: null, incidentId: null, judgmentId: null };

  if (from.riderId && !(await consentsOf(ctx, from.riderId)).locationSensor) throw new ApiError(403, 'consent_required', '위치·센서 수집 동의가 필요해요.');

  const mode = report.mode ?? 'live';
  const dataSource = report.sensorMetadata?.dataSource ?? (mode === 'simulated' ? 'simulation' : 'mock');
  const hasSensor = report.samples ? report.samples.some((s) => s.accG !== null || s.gyroDps !== null) : report.indicators.some((i) => i.state === 'ok' && i.value !== null && ['peak_g', 'peak_gyro'].includes(i.key));
  if (from.deviceId && mode === 'live' && dataSource === 'measured' && hasSensor) {
    await ctx.db.run('UPDATE devices SET lastSensorAt = :now WHERE id = :id', { id: from.deviceId, now: ctx.clock.now() });
  }
  let action: IndicatorReportResponse['action'] = 'logged';
  let reason: IndicatorReportResponse['reason'] = null;
  let incident: IncidentRow | null = null;

  if (isAlarm(decision)) {
    if (!from.riderId) reason = 'not_paired';
    else if (!ctx.config.detectionEnabled) reason = 'detection_disabled';
    else if ((mode !== 'live' || dataSource !== 'measured') && ctx.config.env === 'production') reason = 'not_live';
    else if (!(await activeSession(ctx, from.riderId))) reason = 'no_active_session';
    else {
      try {
        const res = await createIncident(ctx, {
          riderId: from.riderId,
          // 합성 지표로 연 사고는 개발 서버에서만 생기고, 기록에서 테스트로 구분한다.
          source: mode !== 'live' || dataSource !== 'measured' ? 'test' : from.via === 'device' ? 'device' : from.phoneImu ? 'phone' : 'tag',
          kind: kindOf(traces),
          detectedAt: report.detectedAt ? Date.parse(report.detectedAt) : undefined,
          metrics: Object.fromEntries(
            report.indicators.filter((i) => i.state === 'ok' && typeof i.value === 'number').map((i) => [i.key, i.value as number]),
          ),
          deviceId: from.deviceId ?? undefined,
          evidence: { producer: report.producer ?? null, mode, dataSource, ruleVersion: analysis?.ruleVersion ?? 'imu-indicators-v1', thresholds: ctx.config.thresholds, windowS: SENSOR_RULE.windowS, decision, traces, indicators, analysis, receivedAt: iso(ctx.clock.now()), timeBasis: 'sensor seconds since recording start', consents: from.riderId ? await consentsOf(ctx, from.riderId) : null },
          sensorLog: report.samples,
          reportKey: report.reportId ? `${from.deviceId ?? 'phone'}:${report.reportId}` : undefined,
        });
        incident = res.incident;
        action = res.created ? 'incident_created' : 'incident_existing';
      } catch (error) {
        if (!(error instanceof ApiError) || (error.code !== 'stale_event' && error.code !== 'no_active_session')) throw error;
        reason = error.code;
      }
    }
  }

  const judgmentId = newId('jdg');
  await ctx.db.run(
    `INSERT INTO judgments (id, riderId, deviceId, producer, reportId, mode, decision, action, reason, incidentId, indicatorsJson, tracesJson, receivedAt)
     VALUES (:id, :riderId, :deviceId, :producer, :reportId, :mode, :decision, :action, :reason, :incidentId, :indicatorsJson, :tracesJson, :receivedAt)`,
    {
      id: judgmentId,
      riderId: from.riderId,
      deviceId: from.deviceId,
      producer: report.producer,
      reportId: report.reportId,
      mode,
      decision,
      action,
      reason,
      incidentId: incident?.id,
      indicatorsJson: JSON.stringify(report.indicators),
      tracesJson: JSON.stringify(traces),
      receivedAt: ctx.clock.now(),
    },
  );
  if (isAlarm(decision)) ctx.log.info(`지표 판정 ${decision} → ${action}${reason ? ` (${reason})` : ''}${incident ? ` 사고 ${incident.id}` : ''}`);
  return { decision, traces, action, reason, incidentId: incident?.id ?? null, judgmentId };
}

/** 최근 판정 — 경보가 아닌 것까지. 임계값을 맞출 때 기각·판정 불가가 어디서 나오는지 본다. */
export async function listJudgments(ctx: AppContext, limit = 100): Promise<OpsJudgmentDto[]> {
  type Row = { id: string; receivedAt: number; riderName: string | null; riderPhone: string | null; producer: string | null; mode: OpsJudgmentDto['mode']; decision: OpsJudgmentDto['decision']; action: OpsJudgmentDto['action']; reason: OpsJudgmentDto['reason']; incidentId: string | null; tracesJson: string };
  const rows = await ctx.db.all<Row>(
    `SELECT j.*, r.name AS riderName, r.phone AS riderPhone FROM judgments j LEFT JOIN riders r ON r.id = j.riderId
     ORDER BY j.receivedAt DESC LIMIT :limit`,
    { limit },
  );
  return rows.map((r) => ({
    id: r.id,
    receivedAt: iso(r.receivedAt),
    rider: r.riderPhone ? (r.riderName ?? `라이더(${r.riderPhone.slice(-4)})`) : null,
    producer: r.producer,
    mode: r.mode,
    decision: r.decision,
    action: r.action,
    reason: r.reason,
    incidentId: r.incidentId,
    traces: JSON.parse(r.tracesJson),
  }));
}
