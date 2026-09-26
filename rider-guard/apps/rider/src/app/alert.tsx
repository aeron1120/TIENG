// 디자인: design/Alert.dc.html — 사고 확인 (카운트다운)
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState, type ComponentPropsWithRef } from 'react';
import { Animated, BackHandler, Easing, StyleSheet, Vibration, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { errorMessage } from '@/api/client';
import { useIncident, useRespond } from '@/api/hooks';
import { Badge, Button, Screen, Spacer, Txt } from '@/components/ui';
import { useCountdown } from '@/hooks/useCountdown';
import { resetTo } from '@/lib/nav';
import { colors, font, radius } from '@/theme';

const SIZE = 240;
const STROKE = 12;
const R = 104;
const CIRCUMFERENCE = 2 * Math.PI * R; // 653.45

// Animated 가 붙이는 collapsable 을 react-native-svg 웹 구현이 DOM 에 그대로 넘겨 경고가 나므로 걸러낸다.
function RingCircle({ collapsable: _collapsable, ...props }: ComponentPropsWithRef<typeof Circle> & { collapsable?: boolean }) {
  return <Circle {...props} />;
}
const AnimatedCircle = Animated.createAnimatedComponent(RingCircle);

export default function AlertScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: incident, dataUpdatedAt, error } = useIncident(id);
  const respond = useRespond(id);
  const total = incident?.countdownSeconds ?? 30;

  // 서버의 마감 시각을 기기 시계로 옮긴다(시계 오차 보정). 서버는 이 시각에 무응답 에스컬레이션을 시작한다.
  // 첫 응답으로 한 번만 정한다 — 폴링할 때마다 다시 계산하면 네트워크 지연만큼 링이 흔들린다.
  const [deadline, setDeadline] = useState<number | null>(null);
  if (incident && deadline == null) setDeadline(Date.parse(incident.deadlineAt) - (Date.parse(incident.serverTime) - dataUpdatedAt));
  const { left } = useCountdown(deadline);
  // 서버가 먼저 에스컬레이션했으면 기기 카운트다운과 무관하게 만료로 보여준다.
  const expired = left === 0 || (!!incident && incident.status !== 'countdown');

  // 다른 곳에서 사고가 종료됐으면 홈으로
  useEffect(() => {
    if (incident?.status === 'cancelled' || incident?.status === 'resolved') resetTo('/home');
  }, [incident?.status]);

  // 링은 1초 단위로 끊지 않고 마감 시각까지 선형으로 줄어든다.
  const [remaining] = useState(() => new Animated.Value(1)); // 남은 비율 1 → 0
  useEffect(() => {
    if (deadline == null) return;
    const ms = Math.max(0, deadline - Date.now());
    remaining.setValue(ms / (total * 1000));
    const anim = Animated.timing(remaining, { toValue: 0, duration: ms, easing: Easing.linear, useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [deadline, total, remaining]);

  // 애니메이션 프레임이 밀렸더라도 만료면 링도 확실히 비운다.
  useEffect(() => {
    if (expired) remaining.setValue(0);
  }, [expired, remaining]);

  // 감지 즉시 진동 알람 (4.3 1단계). 소리 알람은 TODO — 알람음 에셋과 무음 모드 처리 필요.
  useEffect(() => {
    if (expired) return;
    Vibration.vibrate([0, 700, 500], true);
    return () => Vibration.cancel();
  }, [expired]);

  // 안드로이드 뒤로가기로 응답 없이 빠져나가지 못하게 막는다. 두 버튼 중 하나로만 닫힌다.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const dashOffset = useMemo(
    () => remaining.interpolate({ inputRange: [0, 1], outputRange: [CIRCUMFERENCE, 0] }),
    [remaining],
  );

  const help = () => respond.mutate('help', { onSuccess: () => router.replace({ pathname: '/status', params: { id } }) });
  // 에스컬레이션 뒤의 '괜찮아요'는 서버가 기록만 하고 관제가 확인한다 (설계문서 6.4).
  const ok = () => respond.mutate('ok', { onSuccess: () => resetTo('/home') });
  const problem = respond.error ?? error;

  return (
    <Screen dark top={64} side={24} bottom={36} gap={28}>
      <StatusBar style="light" />

      <View style={{ alignItems: 'center', gap: 10 }}>
        <Badge tone="accent" style={{ alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 12 }}>
          {incident?.kind === 'fall' ? '넘어짐이 감지됐어요' : '강한 충격이 감지됐어요'}
        </Badge>
        <Txt style={styles.h1}>괜찮으신가요?</Txt>
      </View>

      <View style={{ alignItems: 'center' }}>
        <View style={{ width: SIZE, height: SIZE }}>
          <Svg width={SIZE} height={SIZE} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
            <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={colors.inkTrack} strokeWidth={STROKE} />
            <AnimatedCircle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={colors.accentBright}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
          </Svg>
          <View style={styles.center}>
            <Txt accessibilityRole="timer" accessibilityLiveRegion="polite" style={styles.count}>
              {expired ? 0 : (left ?? total)}
            </Txt>
            <Txt style={{ fontSize: 14, color: colors.textOnDarkMuted }}>초 남음</Txt>
          </View>
        </View>
      </View>

      {expired ? (
        <Txt style={[font.sans(700), { fontSize: 16, color: colors.accentOnDark, textAlign: 'center' }]}>응답이 없어 비상연락을 시작했어요</Txt>
      ) : (
        <Txt style={styles.note}>{'응답이 없으면 비상연락처와 관제센터에\n현재 위치를 자동으로 알려요.'}</Txt>
      )}
      {problem && <Txt style={[styles.note, { color: colors.accentOnDark }]}>{errorMessage(problem)}</Txt>}

      <Spacer />

      <View style={{ gap: 12 }}>
        <Button label="도움이 필요해요" height={72} rounded={radius.hero} fontSize={20} disabled={respond.isPending || !incident} onPress={help} />
        <Button
          label="괜찮아요"
          variant="light"
          height={72}
          rounded={radius.hero}
          fontSize={20}
          disabled={respond.isPending || !incident}
          onPress={ok}
        />
        <Txt style={{ fontSize: 12, color: colors.textOnDarkFaint, textAlign: 'center' }}>
          {expired ? '비상연락이 시작된 뒤에는 관제센터가 한 번 더 확인해요.' : "'괜찮아요'를 누르면 오탐으로 기록되고 운행을 계속해요."}
        </Txt>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 30, letterSpacing: -0.6, color: colors.textOnDark },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 2 },
  count: { ...font.mono(600), fontSize: 76, lineHeight: 80, color: colors.textOnDark },
  note: { fontSize: 15, lineHeight: 23, color: colors.textOnDarkSoft, textAlign: 'center' },
});
