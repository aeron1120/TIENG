// 디자인: design/Home.dc.html — 홈 운행 중 (운행 전 상태는 같은 카드의 변형)
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useCreateIncident, useEndSession, useMe, useStartSession } from '@/api/hooks';
import { BottomNav } from '@/components/BottomNav';
import { BatteryIcon, BellIcon, HelmetIcon, PhoneIcon, PinIcon } from '@/components/Icons';
import { Button, Card, Screen, Txt } from '@/components/ui';
import { recentLocation, useLocationState } from '@/features/location';
import { duration } from '@/lib/format';
import { colors, font, radius } from '@/theme';

export default function HomeScreen() {
  // 기기 연결·배터리 표시를 위해 홈에 있는 동안 15초마다 새로 받는다.
  const { data: me, dataUpdatedAt, error } = useMe({ refetchInterval: 15_000 });
  const location = useLocationState();
  const start = useStartSession();
  const end = useEndSession();
  const test = useCreateIncident();
  const driving = !!me?.session;

  // 오늘 운행 시간 — 서버가 준 값에 받은 뒤 흐른 시간을 더한다(기기 시계와 무관).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!driving) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [driving]);
  const driveSeconds = (me?.today.driveSeconds ?? 0) + (driving ? Math.max(0, (now - dataUpdatedAt) / 1000) : 0);

  const device = me?.device;
  const tiles = [
    { Icon: HelmetIcon, label: '감지 기기', value: device ? (device.connected ? '연결됨' : '신호 없음') : '없음', mono: false },
    { Icon: BatteryIcon, label: '배터리', value: device?.battery != null ? `${device.battery}%` : '-', mono: true },
    {
      Icon: PinIcon,
      label: '위치',
      value: !driving ? '꺼짐' : location.permission === 'denied' ? '권한 필요' : location.last ? '공유 중' : '확인 중',
      mono: false,
    },
  ];
  const contacts = me?.contacts ?? [];
  const actionError = start.error ?? end.error ?? test.error ?? error;

  return (
    <Screen top={48} bottom={20} footer={<BottomNav active="home" />}>
      <View style={styles.header}>
        <View style={{ gap: 2 }}>
          <Txt style={styles.muted13}>안녕하세요</Txt>
          <Txt style={[font.sans(700), { fontSize: 22, letterSpacing: -0.4 }]}>{me?.rider.name ?? '라이더'}님</Txt>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="알림" style={styles.bell}>
          <BellIcon size={20} />
        </Pressable>
      </View>

      <View style={styles.drive}>
        <View style={styles.row8}>
          <View style={[styles.dot, !driving && styles.dotOff]} />
          <Txt style={[font.sans(600), { fontSize: 14, color: colors.textOnDark }]}>
            {driving ? '운행 중 · 사고 감지 켜짐' : '운행 전 · 사고 감지 꺼짐'}
          </Txt>
        </View>
        <View style={{ gap: 2 }}>
          <Txt style={styles.clock}>{duration(driveSeconds)}</Txt>
          <Txt style={[styles.muted13, { color: colors.textOnDarkMuted }]}>오늘 운행 시간</Txt>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {tiles.map(({ Icon, label, value, mono }) => (
            <View key={label} style={styles.tile}>
              <Icon size={18} color={colors.info} />
              <Txt style={{ fontSize: 12, color: colors.textOnDarkMuted }}>{label}</Txt>
              <Txt style={[mono ? font.mono(600) : font.sans(600), { fontSize: 14, color: colors.textOnDark }]}>{value}</Txt>
            </View>
          ))}
        </View>
        {driving ? (
          <Button label="운행 종료" variant="outlineOnDark" height={54} fontSize={16} disabled={end.isPending} onPress={() => end.mutate()} />
        ) : (
          <Button label="운행 시작" height={54} fontSize={16} disabled={start.isPending || !me} onPress={() => start.mutate()} />
        )}
      </View>

      {actionError ? (
        <Txt style={[styles.muted13, { paddingHorizontal: 4, color: colors.accent }]}>{errorMessage(actionError)}</Txt>
      ) : (
        <Txt style={[styles.muted13, { paddingHorizontal: 4, lineHeight: 20 }]}>
          운행을 종료하면 사고 감지와 위치 공유가 함께 꺼져요. 운행 중이 아닐 때는 아무것도 수집하지 않아요.
        </Txt>
      )}

      <Card style={styles.contacts}>
        <PhoneIcon size={22} color={colors.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt style={[font.sans(700), { fontSize: 14 }]}>{contacts.length ? `비상연락망 ${contacts.length}명` : '비상연락망 없음'}</Txt>
          <Txt style={styles.muted13}>
            {contacts.length ? contacts.map((c) => `${c.priority}순위 ${c.name}`).join(' · ') : '사고 때 알릴 연락처를 등록해 주세요'}
          </Txt>
        </View>
        <Pressable accessibilityRole="link" onPress={() => router.push('/setup')} style={styles.edit}>
          <Txt style={[font.sans(600), { fontSize: 14, color: colors.accent }]}>{contacts.length ? '수정' : '등록'}</Txt>
        </Pressable>
      </Card>

      {__DEV__ && (
        // 사고를 서버에 실제로 만든다. 확인 화면은 SessionServices 가 띄운다.
        <Button
          label="개발용 · 사고 감지 테스트"
          variant="dashed"
          height={48}
          rounded={radius.lg}
          fontSize={13}
          weight={600}
          textStyle={{ color: colors.textMuted }}
          disabled={test.isPending}
          onPress={() => test.mutate({ source: 'test', kind: 'impact', location: recentLocation() })}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  muted13: { fontSize: 13, color: colors.textMuted },
  bell: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  drive: { gap: 18, paddingTop: 22, paddingHorizontal: 20, paddingBottom: 20, borderRadius: radius.panel, backgroundColor: colors.ink },
  row8: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accentGlow, boxShadow: `0 0 0 4px ${colors.accentGlowHalo}` },
  dotOff: { backgroundColor: colors.textOnDarkFaint, boxShadow: 'none' },
  clock: { ...font.mono(600), fontSize: 44, letterSpacing: -1, color: colors.textOnDark },
  tile: { flex: 1, gap: 6, padding: 12, borderRadius: radius.lg, backgroundColor: colors.inkRaised },
  contacts: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  edit: { minHeight: 44, paddingHorizontal: 6, justifyContent: 'center' },
});
