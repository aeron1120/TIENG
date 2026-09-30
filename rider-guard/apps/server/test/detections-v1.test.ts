import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DetectionV1 } from '@rider-guard/contract';

import { createApp } from '../src/app.ts';
import { DEV_INGEST_TOKEN } from '../src/config.ts';
import { DEMO_RIDER_EMAIL, DEMO_RIDER_ID, seedDemo } from '../src/services/detections.ts';
import { setup } from './helpers.ts';

/** 연동 명세 4장 예시 — A1_v09 재생 (실제 fixture 값) */
function a1(overrides: Partial<DetectionV1> = {}): DetectionV1 {
  return {
    schema_version: '1.0',
    detection_id: 'replay-A1_v09-nominal_200hz.demo0930140000',
    rider_id: DEMO_RIDER_ID,
    order_id: 'demo-order-0001',
    occurred_at: '2026-09-30T14:00:03.120+09:00',
    location: { lat: 37.5665, lng: 126.978, accuracy_m: 15.0, source: 'demo', label: '데모 위치 (실제 위치 아님)' },
    source: {
      mode: 'replay',
      device: 'helmet_tag',
      mount: 'helmet_rear',
      replay: {
        dataset: 'pcx125_handoff_20260928',
        run_id: 'A1_v09',
        scenario_id: 'A1',
        scenario_name: '정지 승용차 측면에 직각 충돌',
        split: 'test',
        ground_truth: 'accident',
        event_onset_s: 1.505,
        detection_delay_s: 0.091,
        rider_speed_kmh: 28.6,
        duration_s: 5.5,
      },
    },
    detector: {
      name: 'tieng-indicator-router',
      version: 'sim-20260928',
      status: 'simulation_candidate_only',
      profile: 'nominal_200hz',
      rule: { expression: 'impact_g AND (rotation_dps OR delta_v_mps OR bank_deg)', window_s: 0.5, warmup_s: 0.15 },
    },
    result: { candidate: true, t_candidate_s: 1.596 },
    evidence: [
      { key: 'impact_g', label: '충격 (가속도 크기)', group: 'required', value: 22.6461, threshold: 4.0, op: '>=', unit: 'g', decimals: 1, fired: true, value_basis: 'run_peak' },
      { key: 'rotation_dps', label: '각속도', group: 'any_of', value: 1092.1974, threshold: 600.0, op: '>=', unit: '°/s', decimals: 0, fired: true, value_basis: 'run_peak' },
      { key: 'delta_v_mps', label: '추정 속도변화 ΔV', group: 'any_of', value: 5.8528, threshold: 3.0, op: '>=', unit: 'm/s', decimals: 1, fired: true, value_basis: 'run_peak' },
      { key: 'bank_deg', label: '헬멧 기울기', group: 'any_of', value: 179.9994, threshold: 75.0, op: 'abs>=', unit: '°', decimals: 0, fired: true, value_basis: 'run_peak' },
    ],
    quality: { sample_rate_hz: 200.0, acc_saturation_fraction: 0.00327, gyro_saturation_fraction: 0.0 },
    post_event: { available: false, stillness_s: null, observed_s: null, reason: '재생 데이터: 실행 길이 5.5 s 로 사후 관찰 구간이 짧음' },
    ...overrides,
  };
}

/** D6_v01 연석 오르내리기 — 충격만 발동, 보조 조건 0개라 후보 아님 */
function d6(): DetectionV1 {
  const base = a1();
  return {
    ...base,
    detection_id: 'replay-D6_v01-nominal_200hz.demo0930140000',
    order_id: 'demo-order-0006',
    source: { ...base.source, replay: { ...base.source.replay!, run_id: 'D6_v01', scenario_id: 'D6', scenario_name: '연석 오르내리기', split: 'unseen_scenario', ground_truth: 'normal', detection_delay_s: null } },
    result: { candidate: false, t_candidate_s: null },
    evidence: [
      { ...base.evidence[0]!, value: 4.6, fired: true },
      { ...base.evidence[1]!, value: 377, fired: false },
      { ...base.evidence[2]!, value: 2.8, fired: false },
      { ...base.evidence[3]!, value: 17, fired: false },
    ],
  };
}

async function demo(env: Record<string, string> = {}) {
  const t = await setup({ DEMO_MODE: 'true', ...env });
  await seedDemo(t.ctx);
  const send = (body: unknown, token = DEV_INGEST_TOKEN) => t.call('POST', '/v1/detections', { body, token });
  return { ...t, send };
}

test('C01·C02 전송 토큰이 없거나 틀리면 401 — 크기보다 인증을 먼저 본다', async () => {
  const t = await demo();
  const app = createApp(t.ctx);
  const noAuth = await app.request('/v1/detections', { method: 'POST', body: 'x'.repeat(70 * 1024) });
  assert.equal(noAuth.status, 401);
  assert.equal(((await noAuth.json()) as { error: { code: string } }).error.code, 'unauthorized');
  assert.equal((await t.send(a1(), 'wrong-token')).status, 401);
  // 운영 모니터 토큰으로는 보낼 수 없다
  assert.equal((await t.send(a1(), t.ctx.config.opsToken)).status, 401);

  const big = await app.request('/v1/detections', { method: 'POST', headers: { authorization: `Bearer ${DEV_INGEST_TOKEN}` }, body: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { error: { code: string } }).error.code, 'payload_too_large');
});

test('C03·C04 깨진 JSON 은 400, 스키마 위반은 422 + details 경로', async () => {
  const t = await demo();
  const app = createApp(t.ctx);
  const broken = await app.request('/v1/detections', { method: 'POST', headers: { authorization: `Bearer ${DEV_INGEST_TOKEN}` }, body: '{"schema_version": ' });
  assert.equal(broken.status, 400);
  assert.equal(((await broken.json()) as { error: { code: string } }).error.code, 'invalid_json');

  const { evidence: _, ...noEvidence } = a1();
  const missing = await t.send(noEvidence);
  assert.equal(missing.status, 422);
  assert.equal(missing.json.error.code, 'validation_failed');
  assert.ok(missing.json.error.details.some((d: { path: string }) => d.path === '$.evidence'));

  // 모르는 필드, 잘못된 op, 시간대 없는 시각, replay 인데 replay 정보 없음
  const bad = a1();
  (bad.evidence[3] as Record<string, unknown>).op = '>';
  (bad as Record<string, unknown>).extra = 1;
  bad.occurred_at = '2026-09-30T14:00:03';
  const invalid = await t.send(bad);
  const paths = invalid.json.error.details.map((d: { path: string }) => d.path);
  assert.ok(paths.includes('$.evidence[3].op'), paths.join());
  assert.ok(paths.includes('$.extra'), paths.join());
  assert.ok(paths.includes('$.occurred_at'), paths.join());
  const noReplay = await t.send(a1({ source: { mode: 'replay', device: 'helmet_tag', mount: 'helmet_rear' } }));
  assert.ok(noReplay.json.error.details.some((d: { path: string }) => d.path === '$.source.replay'));
  // 오류 형식은 기존 API 와 같고 details 는 422 에만
  assert.equal(broken.headers.get('content-type')?.startsWith('application/json'), true);
});

test('C10 등록 안 된 라이더는 422 unknown_rider', async () => {
  const t = await demo();
  const res = await t.send(a1({ rider_id: 'nobody-01' }));
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'unknown_rider');
});

test('C05~C09 후보는 사고를 열고, 재전송은 같은 응답, 다른 본문은 409, 정상은 기록만, 근거 모순은 판정 불가', async () => {
  const t = await demo();

  const first = await t.send(a1());
  assert.equal(first.status, 201);
  assert.equal(first.json.incident_created, true);
  assert.equal(first.json.duplicate, false);
  assert.deepEqual(first.json.warnings, []);
  assert.equal(first.json.incident.status, 'open');
  assert.equal(first.json.incident.level, 'candidate');
  assert.equal(first.json.incident.level_label, '후보 (라이더 확인 대기)');
  assert.equal(first.json.incident.url, `/ops#incident=${first.json.incident.id}`);

  // C06 필드 순서만 다른 같은 본문 → 같은 사고, 다시 열지 않음
  const reordered = Object.fromEntries(Object.entries(a1()).reverse());
  const again = await t.send(reordered);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.incident.id, first.json.incident.id);

  // C07 같은 id, 다른 본문
  const conflict = await t.send(a1({ occurred_at: '2026-09-30T14:00:04.000+09:00' }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'detection_conflict');

  // C08 정상 실행
  const normal = await t.send(d6());
  assert.equal(normal.status, 200);
  assert.equal(normal.json.incident_created, false);
  assert.equal(normal.json.incident, null);

  // C09 후보인데 필수 조건 미발동 → 사고는 연다(판정 불가). 앞 재생 사고는 대신 닫힌다
  const inconsistent = a1({ detection_id: 'replay-A1_v09-bad-evidence-0001' });
  inconsistent.evidence[0] = { ...inconsistent.evidence[0]!, fired: false };
  const c09 = await t.send(inconsistent);
  assert.equal(c09.status, 201);
  assert.equal(c09.json.incident.level, 'undetermined');
  assert.deepEqual(c09.json.warnings, ['evidence_inconsistent']);
  assert.notEqual(c09.json.incident.id, first.json.incident.id);

  const replaced = (await t.ops('GET', `/incidents/${first.json.incident.id}`)).json;
  assert.equal(replaced.status, 'cancelled');
  assert.ok(replaced.timeline.some((e: { type: string }) => e.type === 'superseded'));

  // 디버깅용 조회: 받은 본문과 첫 응답
  const fetched = await t.call('GET', `/v1/detections/${first.json.detection_id}`, { token: DEV_INGEST_TOKEN });
  assert.equal(fetched.json.response.incident.id, first.json.incident.id);
  assert.equal(fetched.json.request.detection_id, first.json.detection_id);
});

test('C11 운영 모니터 사고 상세의 evidence 는 보낸 값 그대로 — 좌표는 싣지 않는다', async () => {
  const t = await demo();
  const sent = a1();
  const { json } = await t.send(sent);
  const detail = (await t.ops('GET', `/incidents/${json.incident.id}`)).json;
  assert.deepEqual(detail.detection.evidence, sent.evidence);
  assert.deepEqual(detail.detection.detector, sent.detector);
  assert.deepEqual(detail.detection.location, { source: 'demo', label: '데모 위치 (실제 위치 아님)' });
  assert.equal(detail.level, 'candidate');
  assert.equal(detail.replay.runId, 'A1_v09');
  assert.equal(detail.timeline[0].type, 'detected');
  assert.equal(detail.timeline[0].data.via, 'router');
  // 데모 모드에서는 라이더 확인 전 사고도 목록에 보인다
  assert.equal((await t.ops('GET', '/incidents')).json.items[0].id, json.incident.id);
  // 최근 수신
  const recent = (await t.ops('GET', '/detections')).json.items;
  assert.equal(recent[0].replay.runId, 'A1_v09');
  assert.equal(recent[0].incidentId, json.incident.id);
});

test('데모 모드: 무응답이어도 문자·119·배차 요청은 밖으로 나가지 않고, 흐름과 등급은 그대로 진행된다', async () => {
  const t = await demo();
  const { json } = await t.send(a1());
  await t.advance(31); // 카운트다운 만료 → 에스컬레이션
  await t.advance(1);
  await t.advance(120); // 2순위 간격까지 지나도

  assert.deepEqual(t.sms, []);
  assert.deepEqual(t.reports, []);
  assert.deepEqual(t.reassigned, []);

  const detail = (await t.ops('GET', `/incidents/${json.incident.id}`)).json;
  assert.equal(detail.status, 'escalated');
  // 재생 데이터는 사후 관찰 구간이 없어 무동작 확인 불가
  assert.equal(detail.level, 'alert_no_stillness');
  const types = detail.timeline.map((e: { type: string; data: { demo?: boolean } | null }) => `${e.type}${e.data?.demo ? ':demo' : ''}`);
  assert.ok(types.includes('contact_notified:demo'), types.join());
  assert.ok(types.includes('emergency_reported:demo'), types.join());
  assert.ok(types.includes('order_reassigned:demo'), types.join());
  // 보내는 쪽이 알려 준 주문을 보류했다
  assert.equal(detail.order.id, 'demo-order-0001');
});

test('데모 초기화: 재생 사고와 기록을 지우고 주문을 되돌린다. 데모 모드가 아니면 403', async () => {
  const off = await setup();
  const denied = await off.call('POST', '/v1/demo/reset', { token: DEV_INGEST_TOKEN });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'demo_mode_off');
  assert.deepEqual((await off.call('GET', '/healthz')).json, { ok: true, schema_version: '1.0', demo_mode: false });

  const t = await demo();
  assert.equal((await t.call('GET', '/healthz')).json.demo_mode, true);
  await t.send(a1());
  await t.send(d6());
  await t.advance(31);
  await t.advance(1);
  const reset = await t.call('POST', '/v1/demo/reset', { token: DEV_INGEST_TOKEN });
  assert.deepEqual(reset.json, { deleted_incidents: 1, deleted_detections: 2 });
  assert.equal((await t.ops('GET', '/incidents')).json.items.length, 0);
  const order = await t.ctx.db.get<{ status: string; incidentId: string | null }>("SELECT status, incidentId FROM orders WHERE id = 'demo-order-0001'");
  assert.deepEqual({ ...order }, { status: 'assigned', incidentId: null });
  // 같은 fixture 를 다시 보내면 다시 열린다
  assert.equal((await t.send(a1())).status, 201);
});

test('앱 계정: 운행 중이 아니면 기록만, 운행 중이면 사고 확인 푸시까지 — 재생이면 문자는 안 나간다 (데모 모드 아님)', async () => {
  const t = await setup();
  const token = await t.login();
  const riderId = (await t.call('GET', '/me', { token })).json.rider.id;
  await t.call('POST', '/me/contacts', { token, body: { name: '엄마', relation: 'family', phone: '010-2222-3333' } });
  await t.call('PUT', '/me/push-token', { token, body: { token: 'ExponentPushToken[abc]', platform: 'android' } });
  const body = a1({ rider_id: riderId, order_id: null, location: null });
  const send = (b: unknown) => t.call('POST', '/v1/detections', { body: b, token: DEV_INGEST_TOKEN });

  const offDuty = await send(body);
  assert.equal(offDuty.status, 200);
  assert.equal(offDuty.json.incident, null);
  assert.deepEqual(offDuty.json.warnings, ['rider_not_on_duty']);

  await t.call('POST', '/me/session', { token });
  const onDuty = await send({ ...body, detection_id: 'replay-A1_v09-on-duty-0001' });
  assert.equal(onDuty.status, 201);
  const active = (await t.call('GET', '/me/incidents/active', { token })).json.incident;
  assert.equal(active.id, onDuty.json.incident.id);
  assert.equal(active.source, 'test');
  assert.equal(active.kind, 'impact');

  await t.advance(1);
  assert.equal(t.pushes.length, 1);
  await t.advance(31);
  await t.advance(1);
  assert.deepEqual(t.sms, []);
  assert.deepEqual(t.reports, []);
  // 운영 서버(데모 아님)는 확인 전 사고를 목록에 싣지 않는다 — 에스컬레이션 뒤에는 보인다
  assert.equal((await t.ops('GET', '/incidents')).json.items.length, 1);
});

test('데모 라이더는 DEMO_RIDER_PASSWORD 로 앱에 로그인할 수 있고, 운행 중으로 시작한다', async () => {
  const t = await demo({ DEMO_RIDER_PASSWORD: 'demo-password-1' });
  const login = await t.call('POST', '/auth/login', { body: { email: DEMO_RIDER_EMAIL, password: 'demo-password-1' } });
  assert.equal(login.status, 200);
  const me = (await t.call('GET', '/me', { token: login.json.token })).json;
  assert.equal(me.rider.id, DEMO_RIDER_ID);
  assert.equal(me.onboarded, true);
  assert.ok(me.session);
  assert.equal(me.contacts[0].phone, '01000000000');
  assert.equal(me.consents.medicalInfo, false);
});
