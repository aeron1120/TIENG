// One control bar drives the same incident across rider, operations and sensor evidence.
import Head from 'expo-router/head';
import { useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { evidenceHeadline } from '@/components/IncidentEvidence';
import { ControlRoom } from '@/components/demo/ControlRoom';
import { LiveWave } from '@/components/demo/LiveWave';
import { RiderPhone } from '@/components/demo/RiderPhone';
import { PresentationPanel } from '@/components/demo/PresentationPanel';
import { GuidedTourProvider, TourTarget, useGuidedTour } from '@/components/tour/GuidedTour';
import { DEMO_TOUR } from '@/components/tour/steps';
import { Badge, Txt } from '@/components/ui';
import { useDemo } from '@/features/demo/data';
import { candidateDemoT, clockAt } from '@/features/demo/engine';
import { dispatch } from '@/features/demo/store';
import { colors, font, radius, typography } from '@/theme';

export default function DemoScreen() {
  return <GuidedTourProvider steps={DEMO_TOUR} onStart={() => dispatch({ type: 'pause' })}><DemoContent /></GuidedTourProvider>;
}

function DemoContent() {
  const tour = useGuidedTour();
  const { s, data } = useDemo();
  const { width, height, fontScale } = useWindowDimensions();
  const [detail, setDetail] = useState(false);
  const wide = width / Math.max(1, fontScale) >= 1180;
  const clip = data.ready ? data.clip : null;
  const cT = clip ? candidateDemoT(clip) : null;
  const verdictVisible = !!s.incident || s.clipDone || (cT !== null && s.t >= cT);
  const wave = <TourTarget name="demo-sensor" style={styles.waveCard}>
    <View style={styles.waveHead}>
      <View style={styles.waveTitleRow}>
        <Txt style={styles.waveTitle}>실측 파형 재생</Txt>
        {detail && data.ready ? <Badge tone="neutral" size="sm">{data.event.source.label}</Badge> : null}
      </View>
      <Txt style={styles.sub}>점선: 기준 · 분홍: 판정창</Txt>
    </View>
    {data.ready ? <>
      <View style={styles.verdict}>
        <Txt style={styles.verdictText}>{verdictVisible ? `${detail && cT !== null ? `${clockAt(s, cT)} · ` : ''}${evidenceHeadline(data.event.analysis)}` : '판정 대기'}</Txt>
      </View>
      <LiveWave timeline={data.timeline} analysis={data.event.analysis} clip={data.clip} t={s.t} columns={detail && wide || wide && width >= 1750 ? 2 : 1} height={detail ? 100 : 52} />
      {detail ? <>
        <Txt style={styles.note}>{`규칙 ${data.event.analysis.ruleVersion} · 판정창 ${data.event.analysis.windowS}초 · 순번 누락 ${data.event.analysis.quality.missingPackets}개 · ΔV ${data.event.analysis.quality.dvValid ? '유효' : '일부 계산 불가'}`}</Txt>
        <Txt style={styles.note}>{`출처: ${data.event.source.note}. 수신 성공·후보 감지는 사고 확정이나 구조 완료를 뜻하지 않아요.`}</Txt>
        <Txt style={styles.note}>판정은 운영 서버와 같은 코드가 이 파형에 대해 낸 결과이며, 검출률·정확도를 뜻하지 않아요.</Txt>
      </> : null}
    </> : <Txt style={styles.sub}>실측 파형을 불러오는 중이에요.</Txt>}
  </TourTarget>;

  return <>
    <Head><title>Rider Guard 통합 시연</title></Head>
    <ScrollView {...tour.scrollProps} style={styles.page} contentContainerStyle={styles.content} stickyHeaderIndices={!tour.active && wide && height >= 650 && !detail ? [0] : undefined}>
      <View style={styles.sticky}>
        <PresentationPanel s={s} clip={clip} loading={!data.ready && data.loading} error={!data.ready ? data.error : null} detail={detail} onDetailChange={setDetail} />
      </View>
      <View style={[styles.main, wide && styles.mainWide]}>
        <TourTarget name="demo-rider" style={[styles.phoneCol, wide && styles.phoneWide]}>
          <Txt style={styles.colLabel}>라이더</Txt>
          <RiderPhone s={s} compact={!detail} />
        </TourTarget>
        <TourTarget name="demo-control" style={styles.controlCol}>
          <Txt style={styles.colLabel}>관제</Txt>
          <ControlRoom s={s} analysis={data.ready ? data.event.analysis : null} compact={!detail} mapHeight={240} />
        </TourTarget>
        {!detail ? <View style={styles.evidenceCol}><Txt style={styles.colLabel}>센서</Txt>{wave}</View> : null}
      </View>
      {detail ? wave : null}
    </ScrollView>
  </>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 12, maxWidth: 1920, width: '100%', alignSelf: 'center' },
  sticky: { backgroundColor: colors.bg, paddingBottom: 2 },
  sub: { ...typography.caption },
  main: { gap: 12 },
  mainWide: { flexDirection: 'row', alignItems: 'flex-start' },
  phoneCol: { gap: 6, width: '100%' },
  phoneWide: { width: 310, flexShrink: 0 },
  controlCol: { flex: 1, gap: 6, minWidth: 0, width: '100%' },
  evidenceCol: { flex: 1, gap: 6, minWidth: 0, width: '100%' },
  colLabel: { ...font.sans(700), fontSize: 13, color: colors.textMuted },
  waveCard: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 10 },
  waveHead: { gap: 5 },
  waveTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  waveTitle: { ...font.sans(800), fontSize: 17, color: colors.text },
  verdict: { backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, padding: 9 },
  verdictText: { ...font.sans(700), fontSize: 13, lineHeight: 19, color: colors.text },
  note: { ...typography.meta },
});
