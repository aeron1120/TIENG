// 통합 시연 (로그인 없음) — 라이더 화면 · 대행사 관제 화면 · 센서 파형을 나란히, 같은 사건·같은 시계로.
import Head from 'expo-router/head';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { evidenceHeadline } from '@/components/IncidentEvidence';
import { ControlRoom } from '@/components/demo/ControlRoom';
import { DemoBar } from '@/components/demo/DemoBar';
import { LiveWave } from '@/components/demo/LiveWave';
import { RiderPhone } from '@/components/demo/RiderPhone';
import { Badge, Txt } from '@/components/ui';
import { useDemo } from '@/features/demo/data';
import { candidateDemoT, clockAt, SCENARIOS } from '@/features/demo/engine';
import { colors, font, radius, typography } from '@/theme';

export default function DemoScreen() {
  const { s, data } = useDemo();
  const { width } = useWindowDimensions();
  const wide = width >= 1180;
  const clip = data.ready ? data.clip : null;
  const cT = clip ? candidateDemoT(clip) : null;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>Rider Guard 통합 시연</title>
      </Head>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Txt style={styles.title}>Rider Guard 통합 시연</Txt>
          <Txt style={styles.sub}>헬멧 센서 파형 → 서버 판정 → 라이더 확인 → 배달대행사 관제 → 주문 처리 → 사건 보고서</Txt>
        </View>
        <Badge tone="neutral">{data.ready ? data.event.source.label : 'ESP32·MPU6050 실측'}</Badge>
        <Badge tone="neutral">라이더·주문·위치: 시연 데이터</Badge>
      </View>

      <DemoBar s={s} clip={clip} loading={!data.ready && data.loading} error={!data.ready ? data.error : null} />

      <View style={[styles.main, wide && styles.mainWide]}>
        <View style={styles.phoneCol}>
          <Txt style={styles.colLabel}>라이더 화면</Txt>
          <RiderPhone s={s} height={wide ? 780 : 720} />
        </View>
        <View style={styles.controlCol}>
          <Txt style={styles.colLabel}>배달대행사 관제 화면</Txt>
          <ControlRoom s={s} analysis={data.ready ? data.event.analysis : null} mapHeight={wide ? 280 : 240} />
        </View>
      </View>

      <View style={styles.waveCard}>
        <View style={styles.waveHead}>
          <View style={styles.flex}>
            <Txt style={styles.waveTitle}>헬멧 센서 파형 — 최근 3초</Txt>
            <Txt style={styles.sub}>
              {data.ready
                ? `빨간 점선 = 운영 규칙(${data.event.analysis.ruleVersion}) 기준 · 분홍 = 판정창 0.5초 · 빨간 선 = 사고 후보 시각`
                : '파형을 불러오는 중'}
            </Txt>
          </View>
          {data.ready ? (
            <View style={styles.verdict}>
              <Txt style={styles.verdictText}>
                {cT === null
                  ? `${SCENARIOS[s.scenario].short}: ${evidenceHeadline(data.event.analysis)}`
                  : s.t >= cT
                    ? `${clockAt(s, cT)} ${evidenceHeadline(data.event.analysis)} (파형 ${data.event.analysis.candidateAt!.toFixed(3)}초)`
                    : '판정 대기 — 사고 후보 조건을 아직 채우지 않았어요'}
              </Txt>
            </View>
          ) : null}
        </View>
        {data.ready ? <LiveWave timeline={data.timeline} analysis={data.event.analysis} clip={data.clip} t={s.t} columns={wide ? 2 : 1} /> : null}
        <Txt style={styles.note}>
          {data.ready ? `출처: ${data.event.source.note}. 판정은 운영 서버와 같은 코드가 이 파형에 대해 낸 결과예요. 검출률·정확도를 뜻하지 않아요.` : ''}
        </Txt>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 14, maxWidth: 1640, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  flex: { flex: 1, minWidth: 260 },
  title: { ...font.sans(800), fontSize: 26, lineHeight: 34, letterSpacing: -0.8, color: colors.text },
  sub: { ...typography.caption },
  main: { gap: 14 },
  mainWide: { flexDirection: 'row', alignItems: 'flex-start' },
  phoneCol: { gap: 6, alignItems: 'center' },
  controlCol: { flex: 1, gap: 6, minWidth: 0 },
  colLabel: { ...font.sans(700), fontSize: 13, color: colors.textMuted, alignSelf: 'flex-start' },
  waveCard: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 16, gap: 12 },
  waveHead: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  waveTitle: { ...font.sans(800), fontSize: 17, color: colors.text },
  verdict: { backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 8 },
  verdictText: { ...font.sans(700), fontSize: 13.5, color: colors.text },
  note: { ...typography.meta },
});
