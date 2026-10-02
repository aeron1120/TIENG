import { useQuery } from '@tanstack/react-query';
import Head from 'expo-router/head';
import { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';

import { API_URL, ApiError, api } from '@/api/client';
import { IncidentReportView, ReportMessage } from '@/components/report/IncidentReportView';
import { GuidedTourProvider } from '@/components/tour/GuidedTour';
import { useDemoCase } from '@/features/demo/data';
import { SCENARIOS } from '@/features/demo/engine';
import { usePresentationConnection } from '@/features/demo/presentation';
import { buildReport, reportAccess, reportTourSteps, type ReportSource } from '@/features/demo/report';
import { useDemoState } from '@/features/demo/store';
import type { PresentationSession } from '../../../../../packages/demo/presentation';

const permanent = (error: unknown) => error instanceof ApiError && [401, 404, 410].includes(error.status);

export default function DemoReportScreen() {
  const local = useDemoState();
  const connection = usePresentationConnection();
  const [hash, setHash] = useState(() => Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.hash : '');
  const [frozen, setFrozen] = useState<ReportSource | null>(null);
  const [structureOpen, setStructureOpen] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const changed = () => { setHash(window.location.hash); setFrozen(null); setStructureOpen(false); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const access = useMemo(() => reportAccess(hash, connection, API_URL), [hash, connection]);
  const id = access.kind === 'server' ? access.id : null;
  const token = access.kind === 'server' ? access.token : null;
  const received = useQuery({
    queryKey: ['incident-report', id, token], enabled: access.kind === 'server', gcTime: 0,
    queryFn: async () => {
      if (!id || !token) throw new Error('보고서 읽기 링크가 필요합니다.');
      const result = await api<PresentationSession>('GET', `/demo-api/presentations/${id}`, undefined, { token, timeoutMs: 60_000 });
      if (result.id !== id) throw new Error('요청한 보고서와 수신한 기록이 일치하지 않습니다.');
      return result;
    },
    retry: (attempt, error) => !permanent(error) && attempt < 2,
    refetchInterval: (query) => frozen || permanent(query.state.error) ? false : 5000,
    refetchOnWindowFocus: !frozen,
  });
  const evidence = useDemoCase(access.kind === 'local' ? local.incident?.caseId ?? (local.clipDone ? SCENARIOS[local.scenario].caseId : null) : null);
  const source = useMemo<ReportSource | null>(() => access.kind === 'server'
    ? received.data ? { kind: 'server', session: received.data } : null
    : access.kind === 'local' ? { kind: 'local', state: local, analysis: evidence.data?.analysis ?? null } : null,
  [access.kind, received.data, local, evidence.data]);
  const selected = frozen ?? source;
  const report = useMemo(() => selected ? buildReport(selected) : null, [selected]);
  const steps = useMemo(() => reportTourSteps(structureOpen), [structureOpen]);

  return <View style={{ flex: 1 }}>
    <Head><title>{report?.incident ? `사건 보고서 · ${report.incident.id}` : 'BATON · 사건 보고서'}</title><meta name="referrer" content="no-referrer" /></Head>
    {access.kind === 'unavailable' ? <ReportMessage title="보고서 읽기 링크를 확인해 주세요" body="연결된 화면의 보고서 버튼에서 다시 열 수 있습니다." />
      : !report ? <ReportMessage title={received.isError ? '보고서를 불러오지 못했습니다' : '저장된 기록을 불러오고 있습니다'} body={received.isError ? permanent(received.error) ? '링크가 만료되었거나 접근할 수 없는 기록입니다. 원본 화면에서 보고서를 다시 열어 주세요.' : '서버 연결을 확인하고 다시 시도해 주세요.' : '사건과 처리 이력을 확인하는 중입니다.'} retry={received.isError && !permanent(received.error) ? () => void received.refetch() : undefined} />
      : <GuidedTourProvider key={report.id} steps={steps} onStart={() => { setFrozen(source); setStructureOpen(false); }} onClose={() => setFrozen(null)}>
        <IncidentReportView report={report} structureOpen={structureOpen} openStructure={() => setStructureOpen(true)} closeStructure={() => setStructureOpen(false)}
          refreshing={received.isFetching} stale={received.isError} evidenceLoading={access.kind === 'local' && evidence.isFetching} evidenceError={access.kind === 'local' && evidence.isError}
          refresh={access.kind === 'server' ? () => void received.refetch() : () => void evidence.refetch()} />
      </GuidedTourProvider>}
  </View>;
}
