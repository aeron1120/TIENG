/**
 * 시연 데이터 — 서버 /demo-api (로그인 없음)에서 실측 파형과 서버 판정을 받아 시연 시계에 맞춘다.
 * 무료 서버가 잠들어 있으면 첫 응답까지 30초쯤 걸린다.
 */
import type { DemoCaseDto, DemoResultsDto, SensorAnalysis } from '@rider-guard/contract';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '@/api/client';
import { LEAD_CASE, LEAD_IN_S, SCENARIOS, type CaseId, type EventClip, type ScenarioId } from '@/features/demo/engine';
import { useDemoClock, useDemoState } from '@/features/demo/store';

const WAKE_MS = 60_000;

export function useDemoCase(id: string | null) {
  return useQuery({
    queryKey: ['demo', 'case', id],
    queryFn: () => api<DemoCaseDto>('GET', `/demo-api/cases/${id}`, undefined, { timeoutMs: WAKE_MS }),
    enabled: !!id,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useDemoResults() {
  return useQuery({
    queryKey: ['demo', 'results'],
    queryFn: () => api<DemoResultsDto>('GET', '/demo-api/results', undefined, { timeoutMs: WAKE_MS }),
    staleTime: Infinity,
  });
}

export type TimelinePoint = SensorAnalysis['waveform'][number];

/** 파형 원본 구간 [from, to] */
export const rangeOf = (a: SensorAnalysis) => ({ from: a.waveform[0]?.t ?? 0, to: a.waveform.at(-1)?.t ?? 0 });

/**
 * 시나리오 하나의 재료 — 사건 파형·판정과, 시연 시계 위에 이어 붙인 파형(앞: 정상 주행 반복, 뒤: 사건).
 * 정상 주행 파형은 1.5초 기록을 반복하므로 이어지는 자리에서 선을 끊는다(gap).
 */
export function useScenarioData(scenario: ScenarioId) {
  const caseId: CaseId = SCENARIOS[scenario].caseId;
  const event = useDemoCase(caseId);
  const lead = useDemoCase(LEAD_CASE);

  return useMemo(() => {
    const ev = event.data;
    const ld = lead.data;
    if (!ev || !ld) return { ready: false as const, error: event.error ?? lead.error ?? null, loading: event.isPending || lead.isPending };
    const e = rangeOf(ev.analysis);
    const l = rangeOf(ld.analysis);
    const clip: EventClip = { caseId, from: e.from, to: e.to, candidateAt: ev.analysis.candidateAt, decision: ev.analysis.decision };
    const timeline: TimelinePoint[] = [];
    const lLen = l.to - l.from || 1.5;
    for (let k = 0; k * lLen < LEAD_IN_S; k++) {
      ld.analysis.waveform.forEach((p, i) => {
        const t = k * lLen + (p.t - l.from);
        if (t < LEAD_IN_S) timeline.push({ ...p, t, gap: p.gap || (i === 0 && k > 0), saturated: p.saturated });
      });
    }
    ev.analysis.waveform.forEach((p, i) => timeline.push({ ...p, t: LEAD_IN_S + (p.t - e.from), gap: p.gap || i === 0 }));
    return { ready: true as const, clip, event: ev, lead: ld, timeline };
  }, [event.data, lead.data, event.error, lead.error, event.isPending, lead.isPending, caseId]);
}

/** 시연 화면 하나에서 한 번만 부른다 — 상태 구독 + 시나리오 데이터 + (이 탭이 driver 면) 시계 */
export function useDemo() {
  const s = useDemoState();
  const data = useScenarioData(s.scenario);
  useDemoClock(data.ready ? data.clip : null);
  return { s, data };
}
