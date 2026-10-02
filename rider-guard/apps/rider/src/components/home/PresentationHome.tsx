import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Toggle } from '@/components/forms';
import { HomeView, type HomeModel } from '@/components/home/HomeScreen';
import { useToast } from '@/components/Toast';
import { GuidedTourProvider } from '@/components/tour/GuidedTour';
import { HOME_TOUR } from '@/components/tour/steps';
import { Button, Card, Sheet, Txt } from '@/components/ui';
import { presentationHome } from '@/features/demo/home-data';
import { useNow, wearTime } from '@/features/sim';
import { colors, font, typography } from '@/theme';

export default function PresentationHome() {
  return <GuidedTourProvider steps={HOME_TOUR}><PresentationHomeContent /></GuidedTourProvider>;
}

function PresentationHomeContent() {
  const now = useNow();
  const [started, setStarted] = useState(() => Date.now() - 18 * 60_000 - 40_000);
  const [worn, setWorn] = useState(true);
  const [voice, setVoice] = useState(true);
  const [seen, setSeen] = useState(false);
  const [sheet, setSheet] = useState<'records' | 'settings' | 'affiliation' | null>(null);
  const toast = useToast();
  const me = presentationHome(now, started, worn);
  const setHelmet = (next: boolean) => { if (next) setStarted(Date.now()); setWorn(next); };
  const model: HomeModel = {
    me, meError: null, presentation: true,
    refetch: () => toast.success('수신 상태를 확인했어요'),
    helmet: { worn, voice, ready: true, setWorn: setHelmet, setVoice, protectionPending: null, protectionError: null, heldByIncident: false },
    location: { permission: 'foreground', last: null },
    gps: { status: 'ok', fix: { lat: 37.5006, lng: 127.0364, accuracy: 12, recordedAt: me.lastLocation!.recordedAt } },
    phone: { status: 'device_paired' },
    test: { reset: () => {}, mutate: () => {}, isPending: false, error: null },
    notifications: { unread: seen ? 0 : 1, markSeen: () => setSeen(true), items: [{ id: 'presentation-protection', kind: 'protection', title: '보호가 시작됐어요', body: '헬멧 센서가 연결되어 운행 중 안전 상태를 확인하고 있어요.', at: new Date(started).toISOString(), ago: '조금 전', unread: !seen }] },
    onOpenAffiliation: () => setSheet('affiliation'),
    onNavigate: (tab) => { if (tab !== 'home') setSheet(tab); },
  };
  const title = sheet === 'settings' ? '보호 설정' : sheet === 'records' ? '운행 기록' : '소속 · 진행 주문';
  return <>
    <HomeView model={model} />
    <Sheet visible={sheet !== null} onClose={() => setSheet(null)} title={title}>
      {sheet === 'settings' ? <>
        <View style={styles.row}><View style={styles.grow}><Txt style={styles.label}>헬멧 착용</Txt><Txt style={typography.caption}>착용하면 보호가 자동으로 켜져요</Txt></View><Toggle value={worn} onValueChange={setHelmet} accessibilityLabel="헬멧 착용" /></View>
        <View style={styles.row}><View style={styles.grow}><Txt style={styles.label}>음성 응답</Txt><Txt style={typography.caption}>사고 확인 요청에 말로 응답해요</Txt></View><Toggle value={voice} onValueChange={setVoice} accessibilityLabel="음성 응답" /></View>
        <Card style={styles.card}><Txt style={styles.label}>헬멧 모듈</Txt><Txt style={typography.body}>연결됨 · 배터리 78%</Txt></Card>
        <Button label="통합 시연 화면으로" variant="outline" onPress={() => { setSheet(null); router.push('/demo'); }} />
      </> : sheet === 'records' ? <>
        <Card style={styles.card}><Txt style={styles.label}>오늘의 운행</Txt><Txt style={styles.value}>{wearTime(started, now)}</Txt><Txt style={typography.caption}>{worn ? '운행 중 · 센서 수신 정상' : '운행 종료'}</Txt></Card>
        <Txt style={typography.body}>이번 운행에서 감지된 사고가 없어요.</Txt>
      </> : <>
        <Card style={styles.card}><Txt style={styles.label}>강남 라이더스</Txt><Txt style={typography.body}>배달의민족 · 쿠팡이츠</Txt></Card>
        <Card style={styles.card}><Txt style={styles.label}>배달 중</Txt><Txt style={typography.body}>역삼 한그릇 → 테헤란로 152</Txt></Card>
      </>}
      <Button label="닫기" variant="soft" onPress={() => setSheet(null)} />
    </Sheet>
  </>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  grow: { flex: 1, gap: 4 },
  label: { ...font.sans(700), fontSize: 16, color: colors.text },
  value: { ...font.mono(700), fontSize: 30, color: colors.text },
  card: { padding: 16, gap: 8, backgroundColor: colors.surfaceMuted },
});
