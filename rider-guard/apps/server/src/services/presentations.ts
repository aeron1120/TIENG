import type { DetectionV1 } from '@rider-guard/contract';

import { initialState, reduce, SCENARIOS } from '../shared/demo-engine.ts';
import type { CreatedPresentation, CreatePresentation, PresentationCommand, PresentationSession, PresentationSource } from '../../../../packages/demo/presentation.ts';
import type { AppContext } from '../context.ts';
import { ApiError, iso, newId, newToken, safeEqual, sha256 } from '../lib.ts';
import { canonicalJson } from './detections.ts';
import { esp32Case, isEsp32CaseId } from './esp32-cases.ts';

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const SESSION_CAP = 200;
const COMMAND_CAP = 20000;
type SessionRow = { id: string; readHash: string; writeHash: string; sessionJson: string; expiresAt: number };

function measured(caseId: string, kind: 'integrated' | 'experiment'): Pick<PresentationSession, 'source' | 'clip' | 'analysis' | 'detection'> {
  if (!isEsp32CaseId(caseId)) throw new ApiError(422, 'invalid_case', '없는 실측 조건이에요.');
  const data = esp32Case(caseId);
  return {
    source: { kind, label: `${caseId} · ${data.summary.name}`, note: `${data.source.label} — ${data.source.note}. 대응·주문·위치는 시연 데이터이며 실제 발송하지 않아요.`, caseId },
    clip: { caseId, from: data.analysis.waveform[0]?.t ?? 0, to: data.analysis.waveform.at(-1)?.t ?? 1.5, candidateAt: data.analysis.candidateAt, decision: data.analysis.decision },
    analysis: data.analysis,
    detection: null,
  };
}

function imported(detection: DetectionV1): Pick<PresentationSession, 'source' | 'clip' | 'analysis' | 'detection'> {
  const replay = detection.source.replay!;
  // Keep original sensor time. This is a playback interval, never a fabricated waveform.
  const candidateAt = detection.result.candidate ? detection.result.t_candidate_s : null;
  const anchor = candidateAt ?? replay.event_onset_s ?? 0;
  const from = anchor - 1;
  const source: PresentationSource = {
    kind: 'import', label: replay.scenario_name, caseId: null,
    note: `외부 detection.v1 재생 · ${replay.run_id} · 후보·근거는 보낸 판정 그대로. 원본 파형 미제공. 대응·주문·위치는 시연이며 실제 발송하지 않아요.`,
  };
  return { source, clip: { caseId: replay.scenario_id, from, to: anchor + 0.5, candidateAt }, analysis: null, detection };
}

export async function createPresentation(ctx: AppContext, input: CreatePresentation): Promise<CreatedPresentation> {
  const now = ctx.clock.now();
  const scenario = input.scenario ?? 'full';
  const payload = input.detection ? imported(input.detection) : measured(input.caseId ?? SCENARIOS[scenario].caseId, input.origin === 'integrated' ? 'integrated' : 'experiment');
  const readToken = newToken();
  const writeToken = newToken();
  const session: PresentationSession = {
    id: newId('pres'), ...payload, state: initialState(scenario, input.baseWall ?? now),
    lastSequence: 0, receivedAt: iso(now), expiresAt: iso(now + LIFETIME_MS),
  };
  await ctx.db.tx(async () => {
    // Bounded cleanup on writes also bounds the unauthenticated demonstration store.
    const expired = await ctx.db.all<{ id: string }>('SELECT id FROM presentationSessions WHERE expiresAt <= :now LIMIT 100', { now });
    for (const { id } of expired) {
      await ctx.db.run('DELETE FROM presentationCommands WHERE sessionId = :id', { id });
      await ctx.db.run('DELETE FROM presentationSessions WHERE id = :id', { id });
    }
    const count = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM presentationSessions');
    if ((count?.n ?? 0) >= SESSION_CAP) throw new ApiError(429, 'presentation_capacity', '발표 세션이 많아요. 만료된 세션 정리 후 다시 시작해 주세요.');
    await ctx.db.run('INSERT INTO presentationSessions (id, readHash, writeHash, sessionJson, createdAt, expiresAt) VALUES (:id, :readHash, :writeHash, :sessionJson, :now, :expiresAt)', {
      id: session.id, readHash: sha256(readToken), writeHash: sha256(writeToken), sessionJson: JSON.stringify(session), now, expiresAt: now + LIFETIME_MS,
    });
  });
  return { ...session, readToken, writeToken, monitorPath: `/ops/presentation#session=${encodeURIComponent(session.id)}&key=${encodeURIComponent(readToken)}` };
}

async function authorize(ctx: AppContext, id: string, token: string | undefined, write: boolean): Promise<PresentationSession> {
  if (!token || token.length > 128) throw new ApiError(401, 'unauthorized', '발표 세션 링크의 접근 키가 필요해요.');
  const row = await ctx.db.get<SessionRow>('SELECT * FROM presentationSessions WHERE id = :id', { id });
  const hash = sha256(token);
  if (!row || !(safeEqual(hash, row.writeHash) || (!write && safeEqual(hash, row.readHash)))) throw new ApiError(401, 'unauthorized', '이 발표 세션의 접근 키가 아니에요.');
  if (row.expiresAt <= ctx.clock.now()) throw new ApiError(410, 'presentation_expired', '발표 세션이 만료됐어요. 새 세션을 시작해 주세요.');
  return JSON.parse(row.sessionJson) as PresentationSession;
}

export const readPresentation = (ctx: AppContext, id: string, token?: string) => authorize(ctx, id, token, false);

/** Pure demo reducer only: this service cannot invoke incident or delivery providers. */
export async function commandPresentation(ctx: AppContext, id: string, token: string | undefined, commands: PresentationCommand[]): Promise<PresentationSession> {
  return ctx.db.tx(async () => {
    let session = await authorize(ctx, id, token, true);
    let changed = false;
    for (const command of commands) {
      const bodyHash = sha256(canonicalJson(command.action));
      if (command.seq <= session.lastSequence) {
        const previous = await ctx.db.get<{ bodyHash: string }>('SELECT bodyHash FROM presentationCommands WHERE sessionId = :id AND seq = :seq', { id, seq: command.seq });
        if (previous?.bodyHash !== bodyHash) throw new ApiError(409, 'sequence_conflict', '이미 받은 순번의 명령 내용이 달라요.');
        continue;
      }
      if (command.seq !== session.lastSequence + 1) throw new ApiError(409, 'sequence_gap', `다음 순번은 ${session.lastSequence + 1}이에요. 누락된 명령부터 다시 보내 주세요.`);
      if (command.seq > COMMAND_CAP) throw new ApiError(429, 'presentation_command_limit', '발표 명령 한도에 도달했어요. 새 세션을 시작해 주세요.');
      const action = command.action;
      if (action.type === 'reset' && session.source.kind === 'integrated') {
        session = { ...session, ...measured(SCENARIOS[action.scenario ?? session.state.scenario].caseId, 'integrated') };
      }
      const state = reduce(session.state, action.type === 'tick' ? { ...action, clip: session.clip } : action);
      session = { ...session, state, lastSequence: command.seq, receivedAt: iso(ctx.clock.now()) };
      await ctx.db.run('INSERT INTO presentationCommands (sessionId, seq, bodyHash) VALUES (:id, :seq, :bodyHash)', { id, seq: command.seq, bodyHash });
      changed = true;
    }
    if (changed) await ctx.db.run('UPDATE presentationSessions SET sessionJson = :sessionJson WHERE id = :id', { id, sessionJson: JSON.stringify(session) });
    return session;
  });
}
