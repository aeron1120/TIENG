import type { DetectionResponseV1, DetectionV1, DetectionWarning, OpsDetectionDto } from '@rider-guard/contract';
import { z } from 'zod';

import type { AppContext, DetectionRow, IncidentRow } from '../context.ts';
import { parseJson } from '../db.ts';
import { ApiError, iso, notFound, sha256 } from '../lib.ts';
import { addEvent, createIncident, openIncident, supersedeIncident } from './incidents.ts';
import { evidenceConsistent, levelOf, STATUS_LABEL, statusOf } from './levels.ts';
import { hashPassword } from './password.ts';
import { displayName, setConsents } from './riders.ts';
import { activeSession, startSession } from './sessions.ts';

/**
 * 지표 라우터 판정 수신 (POST /v1/detections, 스키마 1.0 — 지표팀 연동 명세 4장).
 *
 * 판정은 라우터가 한다. 서버는 후보 여부를 뒤집지 않고 fired 를 다시 계산하지 않으며, 조건 이름·기준값·규칙 문장을 모른다.
 * 받은 본문을 그대로 남기고 운영 모니터가 evidence 를 받은 순서대로 그린다. 서버가 하는 일:
 *   1. 근거 일관성 검사 — 어긋나면 경고. 후보인데 어긋나면 사고는 '판정 불가' 등급으로 연다 (가능한 사고를 버리지 않는다)
 *   2. 후보면 사고를 연다 — 앱의 기존 흐름(카운트다운 → 괜찮아요/도움 요청 → 비상연락)을 그대로 탄다. 후보가 아니면 기록만
 *   3. 같은 detection_id 재전송은 첫 응답을 그대로 돌려준다 (본문이 다르면 409) — 보내는 쪽이 안심하고 재시도하게
 *
 * 라우터 판정 → 앱 사고: kind 는 늘 impact(모든 후보는 충격이 필수), source 는 live → device, replay → test.
 * test 사고는 문자·119 를 밖으로 보내지 않는다 (scheduler.deliver).
 */

export const SCHEMA_VERSION = '1.0';

const nullableNumber = z.number().nullable().optional();

const evidenceSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, '소문자 스네이크 형식이어야 해요').max(40),
  label: z.string().min(1).max(40),
  group: z.enum(['required', 'any_of']),
  value: z.number().nullable(),
  threshold: z.number(),
  op: z.enum(['>=', 'abs>=']),
  unit: z.string().min(1).max(16),
  decimals: z.number().int().min(0).max(3),
  fired: z.boolean().nullable(),
  value_basis: z.enum(['window', 'run_peak']),
});

const replaySchema = z.strictObject({
  dataset: z.string().max(120).optional(),
  run_id: z.string().min(1).max(64),
  scenario_id: z.string().min(1).max(64),
  scenario_name: z.string().min(1).max(120),
  split: z.string().max(40).optional(),
  ground_truth: z.string().min(1).max(40),
  event_onset_s: nullableNumber,
  detection_delay_s: nullableNumber,
  rider_speed_kmh: nullableNumber,
  duration_s: nullableNumber,
});

export const detectionSchema = z
  .strictObject({
    schema_version: z.literal(SCHEMA_VERSION),
    detection_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, '8~128자의 A-Z a-z 0-9 . _ : - 여야 해요'),
    rider_id: z.string().min(1).max(64),
    order_id: z.string().min(1).max(64).nullable().optional(),
    occurred_at: z.iso.datetime({ offset: true }),
    location: z
      .strictObject({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy_m: z.number().min(0).nullable().optional(),
        source: z.string().max(40).nullable().optional(),
        label: z.string().max(80).nullable().optional(),
      })
      .nullable()
      .optional(),
    source: z.strictObject({
      mode: z.enum(['live', 'replay']),
      device: z.enum(['helmet_tag', 'phone']),
      mount: z.string().min(1).max(40),
      replay: replaySchema.nullable().optional(),
    }),
    detector: z.strictObject({
      name: z.string().min(1).max(80),
      version: z.string().min(1).max(80),
      status: z.string().min(1).max(80),
      profile: z.string().min(1).max(80),
      rule: z.strictObject({ expression: z.string().min(1).max(300), window_s: z.number().min(0), warmup_s: z.number().min(0) }),
    }),
    result: z.strictObject({ candidate: z.boolean(), t_candidate_s: z.number().nullable() }),
    evidence: z.array(evidenceSchema).min(1).max(16),
    quality: z
      .strictObject({
        sample_rate_hz: nullableNumber,
        acc_saturation_fraction: z.number().min(0).max(1).nullable().optional(),
        gyro_saturation_fraction: z.number().min(0).max(1).nullable().optional(),
      })
      .nullable()
      .optional(),
    post_event: z
      .strictObject({
        available: z.boolean(),
        stillness_s: z.number().min(0).nullable().optional(),
        observed_s: z.number().min(0).nullable().optional(),
        reason: z.string().max(200).nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .superRefine((d, issue) => {
    if (d.source.mode === 'replay' && !d.source.replay) {
      issue.addIssue({ code: 'custom', path: ['source', 'replay'], message: 'replay 면 source.replay 가 필요해요' });
    }
    if (d.result.candidate && d.result.t_candidate_s == null) {
      issue.addIssue({ code: 'custom', path: ['result', 't_candidate_s'], message: 'candidate 가 true 면 숫자여야 해요' });
    }
  });

/** 422 details — 경로는 $.evidence[3].op 꼴. 모르는 필드는 필드마다 한 줄 */
export function validationDetails(error: z.ZodError): { path: string; message: string }[] {
  const toPath = (path: PropertyKey[]) => '$' + path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('');
  return error.issues
    .flatMap((i) =>
      i.code === 'unrecognized_keys' ? i.keys.map((k) => ({ path: toPath([...i.path, k]), message: '모르는 필드예요' })) : [{ path: toPath(i.path), message: i.message }],
    )
    .slice(0, 20);
}

/** 키를 정렬한 JSON — 같은 내용이면 필드 순서가 달라도 같은 해시 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function incidentView(ctx: AppContext, incident: IncidentRow, d: DetectionV1): NonNullable<DetectionResponseV1['incident']> {
  const status = statusOf(incident.status);
  const { level, label } = levelOf(incident, d, ctx.config.thresholds.stillQuietMinS);
  return { id: incident.id, status, status_label: STATUS_LABEL[status], level, level_label: label, url: `/ops#incident=${incident.id}` };
}

/**
 * 판정 1건 수신. 인증·크기·JSON·스키마 검사는 라우트가 끝낸 뒤다.
 * 라이더 확인(422) → 중복 확인(200/409) → 근거 일관성 → 사고 생성(201) 또는 기록만(200). 전부 한 트랜잭션이라 같은 id 가 동시에 와도 한 번만 연다.
 */
export async function ingestDetection(ctx: AppContext, raw: unknown, d: DetectionV1): Promise<{ status: 200 | 201; body: DetectionResponseV1 }> {
  const bodyHash = sha256(canonicalJson(raw));
  // 데모 라이더는 앱에서 운행을 시작할 사람이 없을 수 있다 — 데모 모드에서는 받을 때 운행을 켠다 (해시 계산처럼 트랜잭션 밖에서 미리)
  const demoRider = ctx.config.demoMode && d.rider_id === DEMO_RIDER_ID;

  const result = await ctx.db.tx(async () => {
    if (!(await ctx.db.get('SELECT 1 FROM riders WHERE id = :id', { id: d.rider_id }))) {
      throw new ApiError(422, 'unknown_rider', '등록되지 않은 rider_id 예요.');
    }
    const previous = await ctx.db.get<DetectionRow>('SELECT * FROM detections WHERE id = :id', { id: d.detection_id });
    if (previous) {
      if (previous.bodyHash !== bodyHash) throw new ApiError(409, 'detection_conflict', '같은 detection_id 로 다른 본문이 왔어요. 새 전송은 새 id 로 보내 주세요.');
      return { status: 200 as const, body: { ...(JSON.parse(previous.responseJson) as DetectionResponseV1), duplicate: true }, first: false };
    }

    const warnings: DetectionWarning[] = evidenceConsistent(d) ? [] : ['evidence_inconsistent'];
    let incident: IncidentRow | null = null;
    let created = false;
    if (d.result.candidate) {
      if (demoRider) await startSession(ctx, d.rider_id);
      // 앱이 "운행 중이 아닐 때는 아무것도 수집하지 않아요"라고 약속한다 — 운행 중이 아니면 기록만
      if (!(await activeSession(ctx, d.rider_id))) warnings.push('rider_not_on_duty');
      else {
        const open = await openIncident(ctx, d.rider_id);
        // 재생·테스트 사고는 다음 판정이 대신한다 (시연은 한 건씩 차례로). 실제 사고는 건드리지 않는다
        if (open?.source === 'test') await supersedeIncident(ctx, open, { detectionId: d.detection_id });
        try {
          const res = await createIncident(ctx, {
            riderId: d.rider_id,
            source: d.source.mode === 'live' ? 'device' : 'test',
            kind: 'impact',
            detectedAt: Date.parse(d.occurred_at),
            location: d.location ? { lat: d.location.lat, lng: d.location.lng, accuracy: d.location.accuracy_m ?? undefined } : undefined,
            address: d.location?.source === 'demo' ? (d.location.label ?? '데모 위치 (실제 위치 아님)') : undefined,
            reportKey: `det:${d.detection_id}`,
            orderId: d.order_id ?? undefined,
            syntheticTime: d.source.mode === 'replay',
            detectedEvent: { via: 'router', detectionId: d.detection_id },
          });
          created = res.created;
          // 이미 대응 중인 실제 사고가 있으면 새로 열지 않는다. 그 사고는 이 판정의 근거로 매긴 것이 아니라 돌려주지 않는다
          if (!created) warnings.push('open_incident_exists');
          else {
            incident = res.incident;
            if (warnings.includes('evidence_inconsistent')) await addEvent(ctx, incident.id, 'evidence_inconsistent');
          }
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'stale_event') throw error;
          warnings.push('stale_event');
        }
      }
    } else if (warnings.length) {
      ctx.log.warn(`판정 ${d.detection_id}: 후보가 아닌데 근거는 규칙을 채워요 — 지표팀 확인 필요`);
    }

    const body: DetectionResponseV1 = {
      detection_id: d.detection_id,
      duplicate: false,
      incident_created: created,
      incident: incident ? incidentView(ctx, incident, d) : null,
      warnings,
    };
    await ctx.db.run(
      `INSERT INTO detections (id, bodyHash, bodyJson, responseJson, riderId, incidentId, mode, candidate, receivedAt)
       VALUES (:id, :bodyHash, :bodyJson, :responseJson, :riderId, :incidentId, :mode, :candidate, :receivedAt)`,
      {
        id: d.detection_id,
        bodyHash,
        bodyJson: JSON.stringify(raw),
        responseJson: JSON.stringify(body),
        riderId: d.rider_id,
        // 이 판정이 연 사고만 잇는다
        incidentId: incident?.id ?? null,
        mode: d.source.mode,
        candidate: d.result.candidate,
        receivedAt: ctx.clock.now(),
      },
    );
    return { status: created ? (201 as const) : (200 as const), body, first: true };
  });

  // 전송 1건당 한 줄 — 참고 서버 로그와 나란히 대조할 수 있는 형식
  const replay = d.source.replay;
  ctx.log.info(
    `detection id=${d.detection_id} rider=${d.rider_id} mode=${d.source.mode}${replay ? ` run=${replay.run_id}` : ''} profile=${d.detector.profile} ` +
      `candidate=${d.result.candidate ? 'True' : 'False'} incident=${result.body.incident?.id ?? '-'} status=${result.status}` +
      `${result.first ? '' : ' duplicate'} warnings=${result.body.warnings.length}`,
  );
  return { status: result.status, body: result.body };
}

/** 디버깅용: 받은 본문과 첫 응답 */
export async function getDetection(ctx: AppContext, id: string) {
  const row = await ctx.db.get<DetectionRow>('SELECT * FROM detections WHERE id = :id', { id });
  if (!row) throw notFound('판정');
  return { detection_id: row.id, received_at: iso(row.receivedAt), request: JSON.parse(row.bodyJson) as DetectionV1, response: JSON.parse(row.responseJson) as DetectionResponseV1 };
}

/** 운영 모니터 상단 '최근 수신' — 사고를 열지 않은 정상 판정도 보여야 "열리지 않았다"를 보여 줄 수 있다 */
export async function recentDetections(ctx: AppContext, limit = 5): Promise<OpsDetectionDto[]> {
  type Row = Pick<DetectionRow, 'id' | 'receivedAt' | 'bodyJson' | 'responseJson' | 'mode' | 'candidate' | 'incidentId'> & { riderName: string | null; riderPhone: string | null };
  const rows = await ctx.db.all<Row>(
    `SELECT d.id, d.receivedAt, d.bodyJson, d.responseJson, d.mode, d.candidate, d.incidentId, r.name AS riderName, r.phone AS riderPhone
     FROM detections d LEFT JOIN riders r ON r.id = d.riderId ORDER BY d.receivedAt DESC LIMIT :limit`,
    { limit },
  );
  return rows.map((r) => {
    const replay = (JSON.parse(r.bodyJson) as DetectionV1).source.replay;
    return {
      detectionId: r.id,
      receivedAt: iso(r.receivedAt),
      rider: r.riderName || r.riderPhone ? displayName({ name: r.riderName, phone: r.riderPhone }) : null,
      mode: r.mode,
      replay: replay ? { runId: replay.run_id, scenarioName: replay.scenario_name, groundTruth: replay.ground_truth } : null,
      candidate: r.candidate === 1,
      incidentId: r.incidentId,
      warnings: parseJson<DetectionResponseV1>(r.responseJson)?.warnings ?? [],
    };
  });
}

// ── 데모 모드 (DEMO_MODE) ───────────────────────────────────────

export const DEMO_RIDER_ID = 'demo-rider-01';
/** DEMO_RIDER_PASSWORD 를 넣으면 이 이메일로 앱에 로그인해 데모 라이더로 시연할 수 있다 */
export const DEMO_RIDER_EMAIL = 'demo@riderguard.test';
const DEMO_ORDER_COUNT = 6;
const demoOrderId = (i: number) => `demo-order-${String(i).padStart(4, '0')}`;

/**
 * 데모 라이더 1명(가짜 비상연락처 010-0000-0000, 의료정보 미동의)과 배달 중 주문 6건. 실제 사람 정보를 넣지 않는다.
 * 여러 번 불러도 된다 — 서버가 뜰 때와 데모 초기화 때 부른다. 연락처를 앱에서 바꿨으면 그대로 둔다.
 */
export async function seedDemo(ctx: AppContext) {
  // scrypt 는 느려서 트랜잭션 밖에서 (그동안 다른 요청이 멈추지 않게)
  const passwordHash = ctx.config.demoRiderPassword ? await hashPassword(ctx.config.demoRiderPassword) : null;
  await ctx.db.tx(async () => {
    const now = ctx.clock.now();
    await ctx.db.run(
      `INSERT INTO riders (id, email, passwordHash, loginFailures, lockedUntil, name, phone, onboardedAt, vehicleJson, medicalJson, createdAt)
       VALUES (:id, :email, :passwordHash, 0, NULL, '데모 라이더', '01000000001', :now, NULL, NULL, :now)
       ON CONFLICT (id) DO UPDATE SET email = excluded.email, passwordHash = excluded.passwordHash, loginFailures = 0, lockedUntil = NULL`,
      { id: DEMO_RIDER_ID, email: passwordHash ? DEMO_RIDER_EMAIL : null, passwordHash, now },
    );
    await setConsents(ctx, DEMO_RIDER_ID, { locationSensor: true, shareOnIncident: true, insuranceRecords: false, medicalInfo: false });
    if (!(await ctx.db.get('SELECT 1 FROM contacts WHERE riderId = :riderId', { riderId: DEMO_RIDER_ID }))) {
      await ctx.db.run(
        `INSERT INTO contacts (id, riderId, priority, name, relation, phone, shareLevel, createdAt)
         VALUES ('demo-contact-01', :riderId, 1, '데모 비상연락처', 'family', '01000000000', 'on_incident', :now)`,
        { riderId: DEMO_RIDER_ID, now },
      );
    }
    for (let i = 1; i <= DEMO_ORDER_COUNT; i++) {
      await ctx.db.run(
        `INSERT INTO orders (id, riderId, storeName, destination, status, incidentId, reassignRequestedAt, createdAt, updatedAt)
         VALUES (:id, :riderId, :storeName, '데모 배달지 (실제 주소 아님)', 'assigned', NULL, NULL, :createdAt, :createdAt)
         ON CONFLICT (id) DO NOTHING`,
        // 번호 순서대로 만든 것으로 둔다 — 주문을 지정하지 않은 사고는 가장 최근(0006)부터 보류한다
        { id: demoOrderId(i), riderId: DEMO_RIDER_ID, storeName: `데모 매장 ${i}`, createdAt: now - (DEMO_ORDER_COUNT - i) * 1000 },
      );
    }
    await startSession(ctx, DEMO_RIDER_ID);
  });
}

/**
 * 재생으로 생긴 사고·기록을 지운다 (데모 모드 전용). 판정이 연 사고와 데모 라이더의 사고가 대상이다.
 * 위치 이용 기록(locationAccessLogs)은 법정 보존 기록이라 남긴다. 보류됐던 주문은 다시 배달 중으로 돌린다.
 */
export async function resetDemo(ctx: AppContext): Promise<{ deleted_incidents: number; deleted_detections: number }> {
  if (!ctx.config.demoMode) throw new ApiError(403, 'demo_mode_off', 'DEMO_MODE 가 아니면 초기화할 수 없어요.');
  const counts = await ctx.db.tx(async () => {
    const target = '(SELECT incidentId FROM detections WHERE incidentId IS NOT NULL UNION SELECT id FROM incidents WHERE riderId = :demoRider)';
    const params = { demoRider: DEMO_RIDER_ID, now: ctx.clock.now() };
    for (const sql of [
      `DELETE FROM incidentEvents WHERE incidentId IN ${target}`,
      `DELETE FROM notifications WHERE incidentId IN ${target}`,
      `DELETE FROM pushes WHERE incidentId IN ${target}`,
      `DELETE FROM shareLinks WHERE incidentId IN ${target}`,
      `UPDATE orders SET status = 'assigned', incidentId = NULL, reassignRequestedAt = NULL, updatedAt = :now WHERE incidentId IN ${target}`,
    ]) {
      await ctx.db.run(sql, params);
    }
    const incidents = await ctx.db.run(`DELETE FROM incidents WHERE id IN ${target}`, params);
    const detections = await ctx.db.run('DELETE FROM detections');
    return { deleted_incidents: incidents, deleted_detections: detections };
  });
  await seedDemo(ctx);
  ctx.log.info(`데모 초기화 — 사고 ${counts.deleted_incidents}건, 판정 ${counts.deleted_detections}건 삭제`);
  return counts;
}
