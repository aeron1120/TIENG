import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DetectionV1, SensorAnalysis } from '@rider-guard/contract';
import type { PresentationSession } from '../../../packages/demo/presentation.ts';
import { initialState, reduce, type DemoState } from '../src/features/demo/engine.ts';
import { buildReport, reportAccess, reportTourSteps } from '../src/features/demo/report.ts';

const api = 'https://api.example.test';
const connection = { sessionId: 'other', monitorUrl: `${api}/ops/presentation#session=other&key=other_read` };
const clip = { caseId: 'A1', from: 0, to: 1, candidateAt: 0.2, decision: 'candidate' as const };
function detected(): DemoState {
  let s = reduce(initialState('full', Date.UTC(2026, 9, 2, 8)), { type: 'slowmo', on: false });
  s = reduce(s, { type: 'play', driver: 'test' });
  for (let n = 0; n < 100 && !s.incident; n++) s = reduce(s, { type: 'tick', dt: 0.5, clip });
  return reduce(s, { type: 'pause' });
}
function completed(): DemoState {
  let s = detected();
  for (const action of [{ type: 'respond', response: 'help' }, { type: 'ack' }, { type: 'call' },
    { type: 'reassign', orderId: 'BT-2041', riderId: 'r2' }, { type: 'reassign', orderId: 'BT-2043', riderId: 'r4' }, { type: 'resolve' }] as const) s = reduce(s, action);
  assert.equal(s.incident?.status, 'resolved');
  return s;
}
const analysis: SensorAnalysis = {
  ruleVersion: 'imu-report-v1', decision: 'candidate', candidateAt: 0.2, windowS: 0.5, dvWindowS: 0.15, warmupS: 0.15,
  metadata: { dataSource: 'measured' },
  evidence: [
    { key: 'peak_g', unit: 'g', threshold: 6, value: 6.04, passedAt: 0.2, peak: 10.8, peakAt: 0.3 },
    { key: 'peak_gyro', unit: 'deg/s', threshold: 300, value: 316, passedAt: 0.2, peak: 350, peakAt: 0.3 },
    { key: 'delta_v150', unit: 'm/s', threshold: 3, value: null, passedAt: null, peak: null, peakAt: null },
    { key: 'bank_deg', unit: 'deg', threshold: 45, value: null, passedAt: null, peak: 0, peakAt: 0.2 },
  ],
  quality: { missingPackets: 1, timeAnomalies: 0, sequenceAvailable: true, dvValid: false, dvInvalidReasons: ['packet_gap'], dvValidRatio: 0, interval: { from: 0, to: 0.7, eligible: 5, valid: 0 }, saturation: [] }, waveform: [],
};

test('report links select their own read capability and never fall back from an invalid or missing server link', () => {
  assert.deepEqual(reportAccess('#session=pres_1&key=read_1', connection, api), { kind: 'server', id: 'pres_1', token: 'read_1' });
  assert.equal(reportAccess('#session=pres_1', connection, api).kind, 'unavailable');
  assert.equal(reportAccess('#session=pres_1&key=read_1&key=other', connection, api).kind, 'unavailable');
  assert.equal(reportAccess('', { sessionId: 'pres_1', monitorUrl: null }, api).kind, 'unavailable');
  assert.equal(reportAccess('', { sessionId: 'pres_1', monitorUrl: connection.monitorUrl }, api).kind, 'unavailable');
  assert.equal(reportAccess('', { sessionId: null, monitorUrl: 'https://evil.test/ops/presentation#session=x&key=y' }, api).kind, 'unavailable');
  assert.deepEqual(reportAccess('', { sessionId: null, monitorUrl: null }, api), { kind: 'local' });
});

test('a server report joins the same incident, orders, recipients and receipt without exporting capabilities', () => {
  const s = completed();
  const session = { id: 'pres_1', state: s, analysis, detection: null, clip, source: { kind: 'integrated', label: 'A1', note: 'source note', caseId: 'A1' }, lastSequence: 42, receivedAt: '2026-10-02T08:01:00.000Z', expiresAt: '2026-10-03T08:00:00.000Z', readToken: 'secret_read', writeToken: 'secret_write' } as PresentationSession;
  const report = buildReport({ kind: 'server', session }, '2026-10-02T08:02:00.000Z');
  assert.equal(report.receipt?.sequence, 42);
  assert.equal(report.receipt?.receivedAt, '2026-10-02T08:01:00.000Z');
  assert.equal(report.incident?.id, s.incident?.id);
  assert.equal(report.incident?.status, 'resolved');
  assert.deepEqual(report.orders.map((o) => [o.id, o.originalRiderId, o.riderId]), [['BT-2041', 'r1', 'r2'], ['BT-2043', 'r1', 'r4']]);
  assert.ok(report.orders.every((o) => o.incidentId === report.incident!.id));
  assert.ok(report.notifications.every((n) => report.orders.some((o) => o.id === n.orderId)));
  assert.equal(new Set(report.notifications.map((n) => n.id)).size, report.notifications.length);
  assert.equal(report.metrics.find((m) => m.key === 'peak_g')?.peak, 10.8);
  assert.equal(report.metrics.find((m) => m.key === 'peak_g')?.triggerValue, 6.04);
  assert.equal(report.metrics.find((m) => m.key === 'delta_v150')?.peak, null);
  assert.equal(report.metrics.find((m) => m.key === 'bank_deg')?.peak, 0);
  assert.equal(report.timeline[0].occurredAt, new Date(s.baseWall + s.incident!.detectedT * 1000).toISOString());
  assert.equal(report.timeline.at(-1)?.code, 'CLOSED');
  assert.equal(report.timeline.filter((entry) => entry.code === 'ORDER_REASSIGNED').length, 2);
  assert.deepEqual(report.timeline.find((entry) => entry.code === 'ORDER_HELD')?.orderIds, ['BT-2041', 'BT-2043']);
  assert.ok(!JSON.stringify(report).includes('secret_'));
  assert.equal(report.sourceSnapshot.state.log.length, s.log.length);
});

test('equal-time actions retain the original log order, including calls interleaved with acknowledgement and handoff', () => {
  let state = detected();
  for (const action of [{ type: 'respond', response: 'help' }, { type: 'call' }, { type: 'ack' },
    { type: 'reassign', orderId: 'BT-2041', riderId: 'r2' }, { type: 'call' }] as const) state = reduce(state, action);
  const report = buildReport({ kind: 'local', state, analysis });
  const actions = report.timeline.filter((entry) => entry.actor === 'control' || entry.code === 'ORDER_REASSIGNED');
  assert.deepEqual(actions.map((entry) => entry.code), ['RIDER_CONTACT', 'ACKNOWLEDGED', 'ORDER_REASSIGNED', 'RIDER_CONTACT']);
  assert.equal(new Set(actions.map((entry) => entry.occurredAt)).size, 1);
  assert.ok(actions.every((entry, index) => index === 0 || entry.sourceLogIndex > actions[index - 1].sourceLogIndex));
});

test('imported metrics retain supplied absolute comparisons, verdicts and value basis', () => {
  const detection = { schema_version: '1.0', detection_id: 'import-001', rider_id: 'r1', occurred_at: '2026-10-02T08:00:00Z',
    source: { mode: 'replay', device: 'helmet_tag', mount: 'helmet', replay: { run_id: 'r1', scenario_id: 's1', scenario_name: 'case', ground_truth: 'accident' } },
    detector: { name: 'detector', version: '1', status: 'recorded', profile: 'default', rule: { expression: 'abs(bank) >= 45', window_s: 0.5, warmup_s: 0.15 } },
    result: { candidate: true, t_candidate_s: 0.2 }, evidence: [{ key: 'bank', label: 'bank', group: 'any_of', value: -60, threshold: 45, op: 'abs>=', unit: 'deg', decimals: 1, fired: true, value_basis: 'run_peak' }],
  } satisfies DetectionV1;
  const session = { id: 'external', state: completed(), analysis: null, detection, clip, source: { kind: 'import', label: 'external', note: '', caseId: null }, lastSequence: 7, receivedAt: '2026-10-02T08:01:00Z', expiresAt: '2026-10-03T08:00:00Z' } satisfies PresentationSession;
  const row = buildReport({ kind: 'server', session }).metrics[0];
  assert.equal(row.peak, -60);
  assert.equal(row.operator, 'abs>=');
  assert.equal(row.fired, true);
  assert.equal(row.basis, 'run_peak');
  assert.equal(row.triggerValue, null);
});

test('local and incomplete reports do not claim a server receipt or a completed response', () => {
  const report = buildReport({ kind: 'local', state: initialState(), analysis: null }, '2026-10-02T08:00:00.000Z');
  assert.equal(report.receipt, null);
  assert.equal(report.incident, null);
  assert.equal(report.status, 'monitoring');
  assert.equal(report.timeline.length, 0);
  assert.equal(report.orders.length, 0);
  assert.equal(report.metrics.length, 0);
});

test('report tutorial requires opening the stored structure before continuing and resets on restart', () => {
  assert.equal(reportTourSteps(false).find((step) => step.target === 'report-structure-open')?.complete, false);
  assert.equal(reportTourSteps(true).find((step) => step.target === 'report-structure-open')?.complete, true);
  assert.equal(reportTourSteps(false).find((step) => step.target === 'report-structure-open')?.interaction, 'press');
});
