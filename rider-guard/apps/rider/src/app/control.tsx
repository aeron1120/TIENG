// 관제사 화면 (로그인, 넓은 화면) — 배달대행사 관제. 라이더 목록·지도·사건·주문.
// 대행사 소속 등록(어느 라이더가 이 대행사 소속인지)과 라이더 동의가 시스템에 아직 없어, 실제 라이더의 위치·사고는 열지 않는다.
// 그 전까지는 시연 데이터(실측 파형 + 서버 판정)로 같은 흐름을 운영해 본다.
import Head from 'expo-router/head';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { AccountBar } from '@/components/AccountBar';
import { ControlRoom } from '@/components/demo/ControlRoom';
import { DemoBar } from '@/components/demo/DemoBar';
import { LiveWave } from '@/components/demo/LiveWave';
import { Txt } from '@/components/ui';
import { useDemo } from '@/features/demo/data';
import { colors, font, radius } from '@/theme';

export default function ControlScreen() {
  const { s, data } = useDemo();
  const { width, height } = useWindowDimensions();
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>BATON 관제</title>
      </Head>
      <AccountBar title="BATON 관제" sub="소속 라이더 상태 · 사고 접수 · 주문 보류와 대체 배차" />
      <View style={styles.notice}>
        <Txt style={styles.noticeText}>
          지금은 시연 데이터로 움직여요. 실제 라이더의 위치와 사고는 대행사 소속 등록과 라이더 동의가 연결된 뒤에 이 화면에 들어와요. 센서 파형과 사고 판정은 ESP32 헬멧 IMU 실측 기록을 운영 서버와 같은 규칙으로 판정한 결과예요.
        </Txt>
      </View>
      <ControlRoom s={s} analysis={data.ready ? data.event.analysis : null} mapHeight={Math.max(300, Math.min(480, height - 460))} />
      <DemoBar s={s} clip={data.ready ? data.clip : null} loading={!data.ready && data.loading} error={!data.ready ? data.error : null} />
      {data.ready ? (
        <View style={styles.wave}>
          <Txt style={styles.waveTitle}>선택한 라이더의 헬멧 센서 파형</Txt>
          <LiveWave timeline={data.timeline} analysis={data.event.analysis} clip={data.clip} t={s.t} columns={width >= 1100 ? 2 : 1} height={72} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 14, maxWidth: 1600, width: '100%', alignSelf: 'center' },
  notice: { backgroundColor: colors.notice, borderRadius: radius.lg, padding: 12 },
  noticeText: { ...font.sans(500), fontSize: 13, lineHeight: 19, color: colors.noticeText },
  wave: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 10 },
  waveTitle: { ...font.sans(700), fontSize: 14, color: colors.text },
});
