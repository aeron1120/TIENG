// 대행사 관제 화면만 — 발표 때 넓은 화면에 띄우고, 라이더 화면은 다른 창(/demo/rider)이나 통합 시연에서 함께 움직인다.
import Head from 'expo-router/head';
import { ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { ControlRoom } from '@/components/demo/ControlRoom';
import { DemoBar } from '@/components/demo/DemoBar';
import { useDemo } from '@/features/demo/data';
import { colors } from '@/theme';

export default function DemoControlScreen() {
  const { s, data } = useDemo();
  const { height } = useWindowDimensions();
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>BATON 관제 (시연)</title>
      </Head>
      <ControlRoom s={s} analysis={data.ready ? data.event.analysis : null} mapHeight={Math.max(300, Math.min(520, height - 420))} />
      <DemoBar s={s} clip={data.ready ? data.clip : null} loading={!data.ready && data.loading} error={!data.ready ? data.error : null} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, maxWidth: 1600, width: '100%', alignSelf: 'center' },
});
