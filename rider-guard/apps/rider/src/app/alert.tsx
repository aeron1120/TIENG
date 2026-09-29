// 디자인: spec-v2 v2·7 — 사고 확인 (카운트다운 · 음성 응답 시뮬레이션)
import type { IncidentKind, RiderResponse } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithRef } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Easing, StyleSheet, Vibration, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import { useIncident, useRespond } from '@/api/hooks';
import { Notice } from '@/components/forms';
import { PhoneIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, FadeIn, FadeSwap, Screen, ScreenFooter, SimBadge, Skeleton, Txt, useReducedMotion } from '@/components/ui';
import { useHelmet } from '@/features/helmet';
import { useCountdown } from '@/hooks/useCountdown';
import { resetTo } from '@/lib/nav';
import { colors, font, motion, radius, typography } from '@/theme';

const KIND_TEXT: Record<IncidentKind, string> = { impact: '강한 충격이 감지됐어요', fall: '넘어짐이 감지됐어요' };

// 링 크기 — 키가 작은 폰에서는 버튼(바닥 고정) 위에 링과 카드가 다 보이도록 줄인다.
const RING = {
  regular: { size: 200, stroke: 10, count: 76, gap: 32 },
  compact: { size: 168, stroke: 9, count: 64, gap: 24 },
} as const;

// 스크린리더에는 매초가 아니라 이 순간에만 남은 시간을 읽어 준다.
const ANNOUNCE_AT = new Set([20, 10, 5]);

// Animated 가 붙이는 collapsable 을 react-native-svg 웹 구현이 DOM 에 그대로 넘겨 경고가 나므로 걸러낸다.
function RingCircle({ collapsable: _collapsable, ...props }: ComponentPropsWithRef<typeof Circle> & { collapsable?: boolean }) {
  return <Circle {...props} />;
}
const AnimatedCircle = Animated.createAnimatedComponent(RingCircle);

export default function AlertScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: incident, dataUpdatedAt, error, refetch } = useIncident(id);
  // 응답은 URL 의 id 만으로 보낸다 — 상세 조회가 늦거나 실패해도 두 버튼은 바로 누를 수 있어야 한다.
  const respond = useRespond(id);
  const helmet = useHelmet();
  const toast = useToast();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const ring = height < 760 ? RING.compact : RING.regular;
  const r = (ring.size - ring.stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const total = incident?.countdownSeconds ?? 30;

  // 서버의 마감 시각을 기기 시계로 옮긴다(시계 오차 보정). 서버는 이 시각에 무응답 에스컬레이션을 시작한다.
  // 첫 응답으로 한 번만 정한다 — 폴링할 때마다 다시 계산하면 네트워크 지연만큼 링이 흔들린다.
  const [deadline, setDeadline] = useState<number | null>(null);
  if (incident && deadline == null) setDeadline(Date.parse(incident.deadlineAt) - (Date.parse(incident.serverTime) - dataUpdatedAt));
  const { left } = useCountdown(deadline);
  const closed = incident?.status === 'cancelled' || incident?.status === 'resolved';
  // 서버가 먼저 에스컬레이션했으면 기기 카운트다운과 무관하게 만료로 보여준다.
  // 닫힌 사고는 곧 홈으로 가므로 만료로 그리지 않는다 — '괜찮아요' 직후 '비상연락 중'이 번쩍이지 않게.
  const expired = !closed && (left === 0 || incident?.status === 'escalated');
  const phase = incident ? (expired ? 'expired' : 'count') : error ? 'unknown' : 'loading';

  // 화면을 떠나는 이동은 한 번만 — 내 응답의 onSuccess 와 '다른 곳에서 종료' 감시가 겹치지 않게
  const leaving = useRef(false);
  const leave = useCallback((go: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    go();
  }, []);

  // 다른 곳(잠금화면 버튼 등)에서 사고가 종료됐으면 홈으로. 내가 보낸 응답이면 send 가 이동을 맡는다.
  const answering = respond.isPending || respond.isSuccess;
  useEffect(() => {
    if (closed && !answering) leave(() => resetTo('/home'));
  }, [closed, answering, leave]);

  // 링은 1초 단위로 끊지 않고 마감 시각까지 선형으로 줄어든다.
  // strokeDashoffset 은 SVG 속성이라 네이티브 드라이버를 쓸 수 없다.
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

  const dashOffset = useMemo(
    () => remaining.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] }),
    [remaining, circumference],
  );

  // 초가 넘어갈 때 숫자가 살짝 튀었다 가라앉는다.
  const [tick] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (left == null || expired || reduced) return;
    tick.setValue(1.06);
    const anim = Animated.timing(tick, { toValue: 1, duration: motion.fast, easing: motion.easeOut, useNativeDriver: motion.native });
    anim.start();
    return () => anim.stop();
  }, [left, expired, reduced, tick]);

  useEffect(() => {
    if (left != null && !expired && ANNOUNCE_AT.has(left)) AccessibilityInfo.announceForAccessibility(`${left}초 남았어요`);
  }, [left, expired]);

  const escalatedTitle = incident?.escalationReason === 'rider_requested' ? '도움 요청으로 비상연락을 시작했어요' : '응답이 없어 비상연락을 시작했어요';
  useEffect(() => {
    if (phase === 'expired') AccessibilityInfo.announceForAccessibility(escalatedTitle);
  }, [phase, escalatedTitle]);

  // 감지 즉시 진동 알람 (4.3 1단계). 소리 알람은 TODO — 알람음 에셋과 무음 모드 처리 필요.
  useEffect(() => {
    if (expired || closed) return;
    Vibration.vibrate([0, 700, 500], true);
    return () => Vibration.cancel();
  }, [expired, closed]);

  // 안드로이드 뒤로가기로 응답 없이 빠져나가지 못하게 막는다. 두 버튼 중 하나로만 닫힌다.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const send = (response: RiderResponse) =>
    respond.mutate(response, {
      onSuccess: (next) => {
        if (response === 'help') {
          leave(() => router.replace({ pathname: '/status', params: { id } }));
          return;
        }
        // 비상연락이 시작된 뒤의 '괜찮아요'도 사고를 닫는다 — 서버가 이미 알린 연락처와 119 에 무사하다고 알린다.
        toast.success(next.status === 'cancelled' ? '괜찮다고 기록했어요' : '괜찮다고 알리고 대응을 마쳤어요');
        leave(() => resetTo('/home'));
      },
    });
  const sending = respond.isPending ? respond.variables : null;
  // 조회 오류는 상세를 아직 못 받았을 때만 — 받은 뒤의 폴링 실패는 응답과 상관없다.
  const problem = respond.error ?? (incident ? null : error);

  // 음성 응답은 시뮬레이션 — 헬멧을 쓰고 '말로 응답하기'를 켰을 때만 카드를 띄운다.
  const showVoice = helmet.ready && helmet.voice && helmet.worn;
  const urgent = left != null && left <= 10;

  const footer = (
    <ScreenFooter tone="dark" style={[styles.footer, { paddingBottom: Math.max(insets.bottom + 8, 28) }]}>
      <FadeIn delay={motion.stagger * 3} style={styles.actions}>
        <Notice onDark error={problem} onRetry={!respond.error && error ? () => void refetch() : undefined} retryLabel="다시 불러오기" />
        <Button
          label="도움이 필요해요"
          variant="danger"
          size="xl"
          onDark
          disabled={respond.isPending}
          loading={sending === 'help'}
          accessibilityHint={expired ? '119 신고에 도움이 필요하다고 덧붙여요' : '비상연락처와 119에 바로 알려요'}
          onPress={() => send('help')}
        />
        <Button
          label="괜찮아요"
          variant="white"
          size="xl"
          onDark
          disabled={respond.isPending}
          loading={sending === 'ok'}
          accessibilityHint={expired ? '비상연락처와 119에 괜찮다고 알리고 대응을 마쳐요' : '오탐으로 기록하고 보호를 이어가요'}
          onPress={() => send('ok')}
        />
        <Txt style={styles.foot}>
          {expired
            ? "지금 '괜찮아요'를 누르면 비상연락처와 119에 괜찮다고 알리고 대응을 마쳐요."
            : '응답이 없으면 비상연락처와 119에 현재 위치를 자동으로 알려요.'}
        </Txt>
      </FadeIn>
    </ScreenFooter>
  );

  return (
    <Screen tone="dark" enter="none" top={60} side={24} bottom={16} gap={0} footer={footer}>
      <StatusBar style="light" />

      <FadeIn style={styles.head}>
        <FadeSwap swapKey={incident ? 'kind' : 'wait'}>
          {incident || error ? (
            <Badge tone="dangerSolid" style={styles.badge}>
              {incident ? KIND_TEXT[incident.kind] : '사고가 감지됐어요'}
            </Badge>
          ) : (
            <Skeleton onDark width={150} height={30} radius={radius.pill} />
          )}
        </FadeSwap>
        <Txt accessibilityRole="header" style={styles.title}>
          괜찮으세요?
        </Txt>
      </FadeIn>

      <FadeIn delay={motion.stagger} style={{ alignItems: 'center', marginTop: ring.gap }}>
        <View style={{ width: ring.size, height: ring.size }}>
          <View style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Svg width={ring.size} height={ring.size} style={styles.svg}>
              <Circle cx={ring.size / 2} cy={ring.size / 2} r={r} fill="none" stroke={colors.navyTrack} strokeWidth={ring.stroke} />
              {deadline != null && (
                <AnimatedCircle
                  cx={ring.size / 2}
                  cy={ring.size / 2}
                  r={r}
                  fill="none"
                  stroke={colors.dangerBright}
                  strokeWidth={ring.stroke}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                />
              )}
            </Svg>
          </View>
          <View
            accessible
            accessibilityRole="timer"
            accessibilityLabel={
              phase === 'count' ? `${left ?? total}초 남음` : phase === 'expired' ? '비상연락 중' : phase === 'loading' ? '남은 시간 확인 중' : '남은 시간을 불러오지 못했어요'
            }
            style={styles.center}
          >
            <FadeSwap swapKey={phase} style={styles.centerInner}>
              {phase === 'count' ? (
                <>
                  <Animated.View style={{ transform: [{ scale: tick }] }}>
                    <Txt style={[styles.count, { fontSize: ring.count, lineHeight: ring.count }, urgent && { color: colors.dangerOnDark }]}>
                      {left ?? total}
                    </Txt>
                  </Animated.View>
                  <Txt style={styles.unit}>초 남음</Txt>
                </>
              ) : phase === 'expired' ? (
                <>
                  <PhoneIcon size={32} color={colors.dangerOnDark} strokeWidth={2.2} />
                  <Txt style={styles.calling}>비상연락 중</Txt>
                </>
              ) : phase === 'loading' ? (
                <>
                  <Skeleton onDark width={96} height={ring.count - 8} radius={radius.lg} />
                  <Txt style={styles.unit}>초 남음</Txt>
                </>
              ) : (
                <Txt style={styles.unknown}>남은 시간을{'\n'}불러오지 못했어요</Txt>
              )}
            </FadeSwap>
          </View>
        </View>
      </FadeIn>

      <FadeIn delay={motion.stagger * 2} style={{ marginTop: ring.gap }}>
        <FadeSwap swapKey={phase === 'expired' ? 'expired' : showVoice ? 'voice' : 'none'}>
          {phase === 'expired' ? <EscalatedCard title={escalatedTitle} /> : showVoice ? <VoiceCard /> : null}
        </FadeSwap>
      </FadeIn>
    </Screen>
  );
}

// ── 음성 응답 (시뮬레이션) ─────────────────────────────────────

/** 막대마다 다른 높이 흐름 — 첫 값과 끝 값이 같아 반복이 끊기지 않는다. */
const BAR_PATTERN = [
  [0.45, 1, 0.6, 0.85, 0.45],
  [0.85, 0.5, 1, 0.55, 0.85],
  [1, 0.65, 0.45, 0.95, 1],
  [0.6, 0.95, 0.7, 0.4, 0.6],
  [0.75, 0.45, 0.9, 0.65, 0.75],
];
const BAR_STEPS = [0, 0.25, 0.5, 0.75, 1];

/** 헬멧이 듣고 있다는 느낌의 보라 막대 5개. 동작 줄이기면 멈춘 채로 그린다. */
function VoiceBars() {
  const reduced = useReducedMotion();
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: motion.native }));
    loop.start();
    return () => loop.stop();
  }, [t, reduced]);
  const scales = useMemo(() => BAR_PATTERN.map((outputRange) => t.interpolate({ inputRange: BAR_STEPS, outputRange })), [t]);
  return (
    <View style={styles.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {scales.map((scaleY, i) => (
        <Animated.View key={i} style={[styles.bar, { transform: [{ scaleY: reduced ? 1 : scaleY }] }]} />
      ))}
    </View>
  );
}

function VoiceCard() {
  return (
    <View
      accessible
      accessibilityLabel='음성 응답 시뮬레이션. "괜찮아"라고 말해주세요. 헬멧 스피커로 묻고 듣고 있어요.'
      style={styles.card}
    >
      <VoiceBars />
      <View style={styles.cardText}>
        <Txt style={styles.cardTitle}>&quot;괜찮아&quot;라고 말해주세요</Txt>
        <View style={styles.cardSubRow}>
          <Txt style={styles.cardSub}>헬멧 스피커로 묻고 듣고 있어요</Txt>
          <SimBadge onDark />
        </View>
      </View>
    </View>
  );
}

/** 카운트다운이 끝났거나 서버가 먼저 비상연락을 시작했을 때 음성 카드 자리에 */
function EscalatedCard({ title }: { title: string }) {
  return (
    <View accessible accessibilityLabel={`${title}. 비상연락처와 119에 현재 위치를 알리고 있어요.`} style={styles.card}>
      <View style={styles.cardIcon}>
        <PhoneIcon size={20} color={colors.dangerOnDark} strokeWidth={2.2} />
      </View>
      <View style={styles.cardText}>
        <Txt style={styles.cardTitle}>{title}</Txt>
        <Txt style={styles.cardSub}>비상연락처와 119에 현재 위치를 알리고 있어요</Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 14 },
  badge: { minHeight: 30, paddingHorizontal: 12 },
  title: { ...typography.display, color: colors.textOnDark, textAlign: 'center' },
  svg: { position: 'absolute', transform: [{ rotate: '-90deg' }] },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  // 숫자 덩어리를 링 중심보다 살짝 위로 — 디자인의 시각 중심
  centerInner: { alignItems: 'center', justifyContent: 'center', gap: 2, paddingBottom: 4 },
  count: { ...font.mono(600), letterSpacing: -2, color: colors.textOnDark, textAlign: 'center' },
  unit: { ...font.sans(500), fontSize: 15, lineHeight: 20, color: colors.textOnDarkMuted },
  calling: { ...font.sans(700), fontSize: 16, lineHeight: 22, color: colors.textOnDark, marginTop: 6 },
  unknown: { ...font.sans(500), fontSize: 14, lineHeight: 20, color: colors.textOnDarkMuted, textAlign: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    minHeight: 76,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: radius.xl,
    backgroundColor: colors.alertCard,
  },
  cardIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navyTrack },
  cardText: { flex: 1, gap: 3 },
  cardTitle: { ...font.sans(700), fontSize: 16, lineHeight: 22, color: colors.textOnDark },
  cardSubRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 6, rowGap: 4 },
  cardSub: { fontSize: 13, lineHeight: 19, color: colors.textOnDarkMuted },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 28 },
  bar: { width: 4, height: 26, borderRadius: 2, backgroundColor: colors.violetLight },
  footer: { paddingHorizontal: 24, paddingTop: 12 },
  actions: { gap: 12 },
  foot: { fontSize: 12, lineHeight: 18, color: colors.textOnDarkFaint, textAlign: 'center' },
});
