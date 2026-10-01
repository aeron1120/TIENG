// 라이더 화면만 — 휴대폰이나 다른 창에 띄워 관제 화면과 함께 시연한다.
import Head from 'expo-router/head';
import { ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { DemoBar } from '@/components/demo/DemoBar';
import { RiderPhone } from '@/components/demo/RiderPhone';
import { useDemo } from '@/features/demo/data';
import { colors } from '@/theme';

export default function DemoRiderScreen() {
  const { s, data } = useDemo();
  const { height } = useWindowDimensions();
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>Rider Guard 라이더 (시연)</title>
      </Head>
      <RiderPhone s={s} height={Math.max(680, Math.min(820, height - 40))} />
      <DemoBar s={s} clip={data.ready ? data.clip : null} loading={!data.ready && data.loading} error={!data.ready ? data.error : null} links={false} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, maxWidth: 760, width: '100%', alignSelf: 'center' },
});
