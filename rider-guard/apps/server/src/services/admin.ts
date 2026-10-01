import type { AdminOverviewDto, IncidentSource, IncidentStatus, Resolution } from '@rider-guard/contract';

import type { AppContext } from '../context.ts';
import { parseJson } from '../db.ts';
import { iso } from '../lib.ts';
import { esp32RuleCheck } from './esp32-cases.ts';
import { listJudgments } from './judgments.ts';

/** 관리자 운영 현황 — 실제 서버 데이터를 읽기만 한다. 위치 좌표·연락처는 싣지 않는다. */
export async function adminOverview(ctx: AppContext): Promise<AdminOverviewDto> {
  const [counts] = await ctx.db.all<{ total: number; onSession: number; dispatchers: number }>(
    `SELECT
       (SELECT COUNT(*) FROM riders) AS total,
       (SELECT COUNT(DISTINCT riderId) FROM sessions WHERE endedAt IS NULL) AS onSession,
       (SELECT COUNT(*) FROM riders WHERE role = 'dispatcher') AS dispatchers`,
  );
  const rows = await ctx.db.all<{ id: string; status: IncidentStatus; source: IncidentSource; riderName: string | null; detectedAt: number; resolution: Resolution | null; evidenceJson: string | null }>(
    `SELECT i.id, i.status, i.source, r.name AS riderName, i.detectedAt, i.resolution, i.evidenceJson
     FROM incidents i LEFT JOIN riders r ON r.id = i.riderId
     ORDER BY i.detectedAt DESC LIMIT 50`,
  );
  const check = esp32RuleCheck();
  return {
    riders: { total: Number(counts?.total ?? 0), onSession: Number(counts?.onSession ?? 0), dispatchers: Number(counts?.dispatchers ?? 0) },
    incidents: rows.map(({ evidenceJson, ...r }) => ({
      ...r,
      detectedAt: iso(r.detectedAt),
      dataSource: parseJson<{ dataSource?: string }>(evidenceJson)?.dataSource ?? null,
    })),
    judgments: await listJudgments(ctx, 50),
    ruleCheck: { ruleVersion: check.ruleVersion, matched: check.matched, total: check.total },
  };
}
