import type { AgencyBoardDto } from '@rider-guard/contract';
import { useFocusEffect } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AccountBar } from '@/components/AccountBar';
import { AgencySummary } from '@/components/control/AgencySummary';
import { ControlRoom } from '@/components/demo/ControlRoom';
import { GuidedTourProvider, TourActionButton, TourHelpButton, TourTarget, useGuidedTour } from '@/components/tour/GuidedTour';
import { Badge, Button, Sheet, Txt } from '@/components/ui';
import { controlExperienceReducer, controlTutorialSteps, hasAgencyActivity } from '@/features/demo/control-experience';
import { rangeOf, useDemoCase } from '@/features/demo/data';
import { presentationStage } from '@/features/demo/display';
import { clockAt, initialState, type DemoAction, type DemoState, type EventClip } from '@/features/demo/engine';
import { colors, font, radius, typography } from '@/theme';

const DRIVER = 'dispatcher-guide';

export function DispatcherExperience({ board, liveBoard }: { board: AgencyBoardDto; liveBoard: ReactNode }) {
  const [s, dispatch] = useReducer(controlExperienceReducer, undefined, () => initialState('full'));
  const [practicing, setPracticing] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [report, setReport] = useState(false);
  const event = useDemoCase('A1');
  const clip = useMemo<EventClip | null>(() => event.data ? { caseId: 'A1', ...rangeOf(event.data.analysis), candidateAt: event.data.analysis.candidateAt, decision: event.data.analysis.decision } : null, [event.data]);
  const clipRef = useRef(clip);
  useEffect(() => { clipRef.current = clip; }, [clip]);
  useFocusEffect(useCallback(() => {
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      if (clipRef.current) dispatch({ type: 'tick', dt, clip: clipRef.current });
    }, 100);
    return () => { clearInterval(timer); dispatch({ type: 'pause' }); };
  }, []));
  const showExperience = practicing || !hasAgencyActivity(board);
  const reset = () => { dispatch({ type: 'reset', scenario: 'full', baseWall: Date.now() }); setPicked(null); setReport(false); };
  const steps = useMemo(() => controlTutorialSteps(s, picked), [s, picked]);
  return <GuidedTourProvider steps={steps} onStart={() => { reset(); setPracticing(true); }} onClose={() => { dispatch({ type: 'pause' }); setPracticing(false); }}>
    <DispatcherContent board={board} liveBoard={liveBoard} s={s} clip={clip} dispatch={dispatch} showExperience={showExperience}
      analysis={event.data?.analysis ?? null} loading={event.isPending} error={event.error} retry={() => void event.refetch()}
      onReset={reset} onPick={setPicked} onReport={() => setReport(true)} />
    <Sheet visible={report} onClose={() => setReport(false)} title="관제 대응 기록" scrollable>
      <Txt style={typography.body}>{`${board.agency!.name} · ${s.riders[0].name} 라이더`}</Txt>
      <Txt style={styles.reportTitle}>{s.incident?.status === 'resolved' ? '대응 완료' : '대응 진행 중'}</Txt>
      <Txt style={typography.caption}>{`인계한 주문 ${s.orders.filter((order) => order.status === 'reassigned').length}건 · 연락 기록 ${s.incident?.calls.length ?? 0}건`}</Txt>
      {s.log.map((entry, index) => <View key={index} style={styles.record}><Txt style={styles.recordTime}>{clockAt(s, entry.t)}</Txt><Txt style={styles.recordText}>{entry.text}</Txt></View>)}
      <Button label="닫기" variant="soft" onPress={() => setReport(false)} />
    </Sheet>
  </GuidedTourProvider>;
}

function DispatcherContent({ board, liveBoard, s, clip, dispatch, showExperience, analysis, loading, error, retry, onReset, onPick, onReport }: {
  board: AgencyBoardDto; liveBoard: ReactNode; s: DemoState; clip: EventClip | null;
  dispatch: (action: DemoAction) => void; showExperience: boolean;
  analysis: Parameters<typeof ControlRoom>[0]['analysis']; loading: boolean; error: unknown; retry: () => void;
  onReset: () => void; onPick: (id: string) => void; onReport: () => void;
}) {
  const tour = useGuidedTour();
  const stage = presentationStage(s, clip);
  const title = stage.key === 'ready' ? '관제 준비 완료' : stage.key === 'resolved' ? '대응 완료' : stage.title;
  const description = stage.key === 'ready' ? '라이더 상태와 진행 주문을 확인하세요. 사고 대응 시작을 누르면 감지부터 주문 인계까지 진행할 수 있어요.'
    : stage.key === 'resolved' ? '관제 대응을 마쳤어요. 대응 기록에서 연락 결과와 주문 인계 내역을 확인할 수 있어요.' : stage.description;
  useEffect(() => {
    if (!showExperience && s.playing) dispatch({ type: 'pause' });
    if (!tour.active) return;
    if (tour.stepTarget === 'control-detection' && !s.incident && !s.playing && s.t > 0) dispatch({ type: 'play', driver: DRIVER });
    else if (tour.stepTarget !== 'control-start' && tour.stepTarget !== 'control-detection' && s.playing) dispatch({ type: 'pause' });
  }, [showExperience, s, tour.active, tour.stepTarget, dispatch]);
  return <ScrollView {...tour.scrollProps} style={styles.page} contentContainerStyle={styles.content}>
    <Head><title>BATON 관제</title></Head>
    <AccountBar title="BATON 관제" sub="소속 라이더 보호 상태 · 사고 접수 · 주문 보류와 대체 배차" actions={<>
      <TourHelpButton name="control-help" disabled={!clip || clip.candidateAt === null} />
      {!showExperience && s.incident ? <Button label="도움말 기록" size="sm" variant="soft" onPress={onReport} /> : null}
    </>} />
    <AgencySummary board={board} snapshot={showExperience ? s : null} />
    {!clip || clip.candidateAt === null ? <View style={styles.preparing}>
      <Txt style={styles.note}>{error ? '관제 흐름 데이터를 불러오지 못했어요.' : loading ? '도움말에 사용할 센서 데이터를 준비하고 있어요…' : '이 파형으로 사고 대응을 시작할 수 없어요.'}</Txt>
      {!loading ? <Button label="다시 불러오기" size="sm" variant="outline" onPress={retry} /> : null}
    </View> : null}
    {showExperience ? <TourTarget name="control-detection" style={styles.scenario}>
      <View style={styles.status}><Badge tone={stage.tone === 'danger' ? 'red' : 'neutral'}>{title}</Badge><Txt style={styles.description}>{description}</Txt></View>
      <View style={styles.buttons}>
        <TourActionButton name="control-start" label={s.playing ? '신호 확인 중' : s.t > 0 && !s.incident ? '이어서 확인' : '사고 대응 시작'} size="sm" disabled={!clip || clip.candidateAt === null || s.playing || !!s.incident} onPress={() => dispatch({ type: 'play', driver: DRIVER })} />
        {s.incident?.status === 'confirming' ? <TourActionButton name="control-wait" label="응답 대기 건너뛰기" size="sm" variant="outline" onPress={() => dispatch({ type: 'skipWait' })} /> : null}
        <Button label="처음부터" size="sm" variant="outline" onPress={onReset} />
        <TourActionButton name="control-report" label="대응 기록" size="sm" variant="soft" disabled={!s.incident} onPress={onReport} />
      </View>
    </TourTarget> : null}
    <TourTarget name="demo-control" style={styles.board}>
      {showExperience ? <ControlRoom s={s} analysis={analysis} guided={tour.active} title={`${board.agency!.name} 관제`} showSource={false} onSelectRider={onPick}
        interaction={{ dispatch, blocked: null, openReport: onReport }} /> : liveBoard}
    </TourTarget>
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 14, maxWidth: 1600, width: '100%', alignSelf: 'center' },
  board: { gap: 14 },
  scenario: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 16, gap: 12 },
  status: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  description: { ...typography.caption, flex: 1, minWidth: 240 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preparing: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  note: { ...typography.meta },
  reportTitle: { ...font.sans(800), fontSize: 22, color: colors.text },
  record: { flexDirection: 'row', gap: 10, borderTopWidth: 1, borderColor: colors.divider, paddingVertical: 8 },
  recordTime: { ...font.mono(600), fontSize: 12, color: colors.textMuted },
  recordText: { ...typography.caption, flex: 1 },
});
