// 디자인: spec-v3 v3·7 — 사고 확인 (SOS 구 · 막대 카운트다운). 음성 응답은 어떤 플랫폼에서도 사건 응답에 연결돼 있지 않아 화면 버튼만 쓴다.
import type { IncidentKind, RiderResponse } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  StyleSheet,
  Vibration,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useIncident, useRespond } from '@/api/hooks';
import { Notice } from '@/components/forms';
import { AlarmSoundControl } from '@/components/AlarmSoundControl';
import { AlertCircleFilledIcon, MicIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, FadeIn, FadeSwap, PressableScale, Screen, ScreenFooter, Skeleton, Txt, useReducedMotion } from '@/components/ui';
import { useHelmet } from '@/features/helmet';
import { useVoiceAnswer } from '@/features/voice';
import { useCountdown } from '@/hooks/useCountdown';
import { resetTo } from '@/lib/nav';
import { colors, font, motion, radius, shadow } from '@/theme';

const KIND_TEXT: Record<IncidentKind, string> = { impact: '강한 충격이 감지됐어요', fall: '넘어짐이 감지됐어요' };

/**
 * 크기 — 디자인(390×844) 측정값. 키가 작은 폰은 가운데 묶음을 줄여 버튼(바닥 고정) 위에 다 보이게 한다.
 * sphere = SOS 구 지름, rings = 동심원 안·밖 지름, ripple = 퍼지는 원이 가장 커지는 지름, glow = 붉은 빛 타원 반지름
 */
const SIZES = {
  regular: { sphere: 186, rings: [240, 300], ripple: 332, sos: 50, sosLh: 56, title: 40, titleLh: 48, pillGap: 19.5, voiceGap: 11, blockGap: 23.5, glow: [231, 289] },
  compact: { sphere: 156, rings: [200, 250], ripple: 276, sos: 42, sosLh: 48, title: 34, titleLh: 42, pillGap: 14, voiceGap: 8, blockGap: 16, glow: [194, 242] },
} as const;
type Sizes = (typeof SIZES)[keyof typeof SIZES];

/** 어두운 바탕 위 흰 글자·선의 불투명도 (디자인 측정) */
const DIM = { voice: 0.72, hint: 0.6, foot: 0.5, sub: 0.92, track: 0.14 } as const;

/** '강한 충격이 감지됐어요' 알약 아래 은은한 붉은 그림자 */
const PILL_GLOW = `0 4px 18px ${colors.red}5C`;
/** SOS 구의 붉은 빛 — 사방으로 퍼지는 sosGlow 에 아래로 번지는 빛을 더한다(디자인은 구 아래가 더 밝다) */
const SPHERE_GLOW = `${shadow.sosGlow}, 0 22px 44px ${colors.red}66`;

// 스크린리더에는 매초가 아니라 이 순간에만 남은 시간을 읽어 준다.
const ANNOUNCE_AT = new Set([20, 10, 5]);

export default function AlertScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: incident, dataUpdatedAt, error, refetch } = useIncident(id);
  // 응답은 URL 의 id 만으로 보낸다 — 상세 조회가 늦거나 실패해도 SOS·괜찮아요는 바로 누를 수 있어야 한다.
  const respond = useRespond(id);
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const size: Sizes = height < 760 || width < 360 ? SIZES.compact : SIZES.regular;
  const total = incident?.countdownSeconds ?? 30;

  // 서버의 마감 시각을 기기 시계로 옮긴다(시계 오차 보정). 서버는 이 시각에 무응답 에스컬레이션을 시작한다.
  // 첫 응답으로 한 번만 정한다 — 폴링할 때마다 다시 계산하면 네트워크 지연만큼 막대가 흔들린다.
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

  // 막대는 1초 단위로 끊지 않고 마감 시각까지 선형으로 줄어든다. 폭 애니메이션이라 네이티브 드라이버를 쓰지 않는다.
  const [remaining] = useState(() => new Animated.Value(1)); // 남은 비율 1 → 0
  useEffect(() => {
    if (deadline == null) return;
    const ms = Math.max(0, deadline - Date.now());
    remaining.setValue(Math.min(1, ms / (total * 1000)));
    const anim = Animated.timing(remaining, { toValue: 0, duration: ms, easing: Easing.linear, useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [deadline, total, remaining]);

  // 애니메이션 프레임이 밀렸더라도 만료면 막대도 확실히 비운다. 불러오지 못했으면 빈 트랙만.
  useEffect(() => {
    if (expired || phase === 'unknown') remaining.setValue(0);
  }, [expired, phase, remaining]);
  const barWidth = useMemo(() => remaining.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), [remaining]);

  useEffect(() => {
    if (left != null && !expired && ANNOUNCE_AT.has(left)) AccessibilityInfo.announceForAccessibility(`${left}초 남았어요`);
  }, [left, expired]);

  const escalatedByRider = incident?.escalationReason === 'rider_requested';
  const escalatedTitle = escalatedByRider ? '도움 요청으로 비상연락을 시작했어요' : '응답이 없어 비상연락을 시작했어요';
  useEffect(() => {
    if (phase === 'expired') AccessibilityInfo.announceForAccessibility(escalatedTitle);
  }, [phase, escalatedTitle]);

  // 진동과 웹 경고음은 각각 지원되는 환경에서 동작한다. 웹 경고음은 사용자 준비가 필요하다.
  useEffect(() => {
    if (expired || closed) return;
    Vibration.vibrate([0, 700, 500], true);
    return () => Vibration.cancel();
  }, [expired, closed]);

  // 안드로이드 뒤로가기로 응답 없이 빠져나가지 못하게 막는다. SOS·괜찮아요 중 하나로만 닫힌다.
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
        // 비상연락이 시작된 뒤의 '괜찮아요'도 사고를 닫는다 — 서버가 연락 절차가 진행된 곳에 괜찮다는 소식을 보낸다.
        // 본인 응답일 뿐 '실제 사고 아님' 정답 라벨이 아니다(서버 feedback.groundTruth 는 unknown 으로 남는다).
        toast.success(next.status === 'cancelled' ? '괜찮다고 응답했어요' : '괜찮다고 응답하고 대응을 마쳤어요');
        leave(() => resetTo('/home'));
      },
    });
  const sending = respond.isPending ? respond.variables : null;
  // 말로 응답하기 — 켜 둔 사람만, 카운트다운 중에만 듣는다. 알아들으면 버튼을 누른 것과 똑같이 보낸다
  const { voice } = useHelmet();
  const listen = voice && phase === 'count' && !respond.isPending && !respond.isSuccess;
  const spoken = useVoiceAnswer(listen, (a) => send(a));
  const voiceLine = !voice
    ? '음성 응답 꺼짐 · 화면 버튼으로 알려 주세요'
    : spoken.state === 'listening'
      ? spoken.heard
        ? `“${spoken.heard.slice(-24)}”`
        : '듣고 있어요 · “괜찮아요” 또는 “도와주세요”'
      : spoken.state === 'speaking'
        ? '질문을 읽고 있어요'
        : spoken.state === 'blocked'
          ? '마이크가 막혀 있어요 · 화면 버튼으로 알려 주세요'
          : '화면 버튼으로 알려 주세요';
  // 조회 오류는 상세를 아직 못 받았을 때만 — 받은 뒤의 폴링 실패는 응답과 상관없다.
  const problem = respond.error ?? (incident ? null : error);

  const urgent = phase === 'count' && left != null && left <= 10;

  // 붉은 빛은 SOS 구 가운데에 맞춘다 — 구의 실제 위치를 재서 맨 뒤 층에 그린다.
  const [glowCenter, setGlowCenter] = useState<number | null>(null);
  const onSphereLayout = (e: LayoutChangeEvent) => {
    const { y, height: h } = e.nativeEvent.layout;
    setGlowCenter(Math.round(y + h / 2));
  };

  const footer = (
    <ScreenFooter tone="dark" style={[styles.footer, { paddingBottom: Math.max(insets.bottom + 6, 40) }]}>
      <FadeIn delay={motion.stagger * 3}>
        <Notice
          onDark
          error={problem}
          onRetry={!respond.error && error ? () => void refetch() : undefined}
          retryLabel="다시 불러오기"
          style={styles.notice}
        />
        <Button
          label="괜찮아요"
          variant="white"
          size="xl"
          onDark
          disabled={respond.isPending}
          loading={sending === 'ok'}
          accessibilityHint={expired ? '대응을 마치고 알림을 받은 연락처에 괜찮다는 소식을 보내요' : '본인 응답으로 기록하고 보호를 이어가요'}
          onPress={() => send('ok')}
        />
        <Txt style={styles.foot}>
          {expired
            ? '지금 ‘괜찮아요’를 누르면 대응을 마치고, 알림을 받은 연락처에 괜찮다는 소식을 보내요.'
            : '‘괜찮아요’는 본인 응답으로 기록되고 보호는 계속돼요.'}
        </Txt>
      </FadeIn>
    </ScreenFooter>
  );

  return (
    <Screen tone="dark" enter="none" top={66} side={24} bottom={0} gap={0} footer={footer}>
      <StatusBar style="light" />
      <AlarmSoundControl active={phase === 'count' && !closed && !respond.isPending && !respond.isSuccess} onDark />

      {/* 맨 뒤 층 — 가운데 붉은 방사형 빛 */}
      <View style={[styles.glowLayer, { left: -24, right: -24 }]}>
        {glowCenter != null && (
          <FadeIn offset={0} duration={motion.slow} delay={motion.stagger}>
            <Glow center={glowCenter} rx={size.glow[0]} ry={size.glow[1]} />
          </FadeIn>
        )}
      </View>

      <FadeIn style={styles.head}>
        <FadeSwap swapKey={incident ? 'kind' : error ? 'error' : 'wait'}>
          {incident || error ? (
            <Badge
              tone="redSolid"
              size="lg"
              leading={<AlertCircleFilledIcon size={23} />}
              style={styles.pill}
              textStyle={styles.pillText}
            >
              {incident ? KIND_TEXT[incident.kind] : '사고가 감지됐어요'}
            </Badge>
          ) : (
            <Skeleton onDark width={202} height={38} radius={radius.pill} />
          )}
        </FadeSwap>
        <View accessible accessibilityRole="header" accessibilityLabel="사고가 의심돼요. 괜찮으신가요?" style={{ marginTop: size.pillGap }}>
          <Txt style={styles.question}>사고가 의심돼요.</Txt>
          <Txt style={[styles.title, { fontSize: size.title, lineHeight: size.titleLh }]}>괜찮으신가요?</Txt>
        </View>
        {/* 못 알아들으면 아무것도 보내지 않는다 — 무응답은 카운트다운이 처리하고, 버튼은 늘 함께 쓸 수 있다 */}
        <View style={[styles.voiceRow, { marginTop: size.voiceGap }]} accessibilityLiveRegion="polite">
          {voice ? <MicIcon size={14} color={colors.textOnDark} /> : null}
          <Txt style={styles.voiceText} numberOfLines={1}>{voiceLine}</Txt>
        </View>
      </FadeIn>

      <View onLayout={onSphereLayout} style={{ marginTop: size.blockGap }}>
        <FadeIn delay={motion.stagger}>
          <SosSphere
            size={size}
            sending={sending === 'help'}
            disabled={respond.isPending}
            label={expired ? '도움이 필요하다고 알리기' : '도움이 필요해요'}
            hint={expired ? '진행 중인 연락에 도움이 필요하다고 덧붙여요' : '기다리지 않고 비상연락 절차를 바로 시작해요'}
            onPress={() => send('help')}
          />
        </FadeIn>
      </View>

      <View style={styles.spacer} />

      <FadeIn delay={motion.stagger * 2} style={styles.countdown}>
        <View
          accessible
          accessibilityRole="timer"
          accessibilityLabel={
            phase === 'count'
              ? `${left ?? total}초 남음. 응답이 없으면 자동으로 알려요`
              : phase === 'expired'
                ? escalatedTitle
                : phase === 'loading'
                  ? '남은 시간 확인 중'
                  : '남은 시간을 불러오지 못했어요'
          }
        >
          <View style={styles.bar}>
            <View style={[StyleSheet.absoluteFill, styles.barTrack]} />
            <Animated.View style={[styles.barFill, { width: barWidth }]} />
          </View>
          <View style={styles.countRow}>
            <FadeSwap swapKey={phase} style={styles.countLeft}>
              {phase === 'count' ? (
                <Txt style={[styles.count, urgent && { color: colors.dangerOnDark }]}>{`${left ?? total}초 남음`}</Txt>
              ) : phase === 'expired' ? (
                <Txt style={styles.count}>비상연락 중</Txt>
              ) : phase === 'loading' ? (
                <Skeleton onDark width={96} height={22} radius={radius.sm} style={styles.countSkeleton} />
              ) : (
                <Txt style={styles.unknown}>시간을 못 불러왔어요</Txt>
              )}
            </FadeSwap>
            <Txt style={styles.hint}>
              {phase === 'expired' ? (escalatedByRider ? '도움 요청으로 알렸어요' : '응답이 없어 자동으로 알렸어요') : '응답이 없으면 자동으로 알려요'}
            </Txt>
          </View>
        </View>
      </FadeIn>

      <View style={styles.spacer} />
    </Screen>
  );
}

// ── 붉은 방사형 빛 ─────────────────────────────────────────────

/** 같은 화면에 그림이 여럿이어도 그라데이션 id 가 겹치지 않게 (url(#…) 에 쓸 수 있는 글자만) */
function useSvgId(prefix: string) {
  return prefix + useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

/** 구 가운데를 중심으로 한 세로로 긴 타원 빛. 안쪽 절반은 alertGlow, 바깥으로 갈수록 바탕색으로 사라진다. */
function Glow({ center, rx, ry }: { center: number; rx: number; ry: number }) {
  const gid = useSvgId('glow');
  return (
    <View style={{ marginTop: center - ry, width: rx * 2, height: ry * 2 }}>
      <Svg width={rx * 2} height={ry * 2}>
        <Defs>
          <RadialGradient id={gid} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={colors.alertGlow} stopOpacity={1} />
            <Stop offset="0.48" stopColor={colors.alertGlow} stopOpacity={1} />
            <Stop offset="1" stopColor={colors.alertGlow} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={rx * 2} height={ry * 2} fill={`url(#${gid})`} />
      </Svg>
    </View>
  );
}

// ── SOS 구 ─────────────────────────────────────────────────────

type SosSphereProps = { size: Sizes; sending: boolean; disabled: boolean; label: string; hint: string; onPress: () => void };

/** 누르면 바로 도움 요청 — 빨간 구(왼쪽 위 하이라이트) + 뒤에서 천천히 퍼지는 동심원 */
function SosSphere({ size, sending, disabled, label, hint, onPress }: SosSphereProps) {
  const d = size.sphere;
  const block = size.rings[1];
  const fill = useSvgId('sosFill');
  const shine = useSvgId('sosShine');
  const limb = useSvgId('sosLimb');
  const shade = useSvgId('sosShade');
  const rim = useSvgId('sosRim');
  return (
    <View style={[styles.sosBlock, { width: block, height: block }]}>
      <Ripples size={size} />
      <PressableScale
        scaleTo={0.96}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`SOS, ${label}`}
        accessibilityHint={hint}
        accessibilityState={{ disabled, busy: sending }}
        style={[styles.sphere, { width: d, height: d, borderRadius: d / 2 }, disabled && !sending && styles.sphereOff]}
        pressedStyle={styles.spherePressed}
      >
        <Svg width={d} height={d} style={StyleSheet.absoluteFill}>
          <Defs>
            {/* 왼쪽 위에서 빛을 받은 구 — sosTop → sosBottom */}
            <RadialGradient id={fill} cx="0.35" cy="0.28" r="0.76" fx="0.35" fy="0.28">
              <Stop offset="0" stopColor={colors.sosTop} />
              <Stop offset="0.2" stopColor={colors.sosTop} />
              <Stop offset="0.76" stopColor={colors.red} />
              <Stop offset="0.92" stopColor={colors.sosBottom} />
              <Stop offset="1" stopColor={colors.sosBottom} />
            </RadialGradient>
            <RadialGradient id={shine} cx="0.35" cy="0.28" r="0.18" fx="0.35" fy="0.28">
              <Stop offset="0" stopColor={colors.textOnDark} stopOpacity={0.16} />
              <Stop offset="1" stopColor={colors.textOnDark} stopOpacity={0} />
            </RadialGradient>
            {/* 가장자리는 짙은 빨강으로 살짝, 빛에서 먼 오른쪽 아래는 더 어둡게 — 둥근 느낌 */}
            <RadialGradient id={limb} cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0.8" stopColor={colors.redInk} stopOpacity={0} />
              <Stop offset="1" stopColor={colors.redInk} stopOpacity={0.22} />
            </RadialGradient>
            <RadialGradient id={shade} cx="0.35" cy="0.28" r="0.76" fx="0.35" fy="0.28">
              <Stop offset="0.7" stopColor={colors.redInk} stopOpacity={0} />
              <Stop offset="1" stopColor={colors.redInk} stopOpacity={0.5} />
            </RadialGradient>
            {/* 위쪽 테두리의 가는 반사광 */}
            <LinearGradient id={rim} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.textOnDark} stopOpacity={0.3} />
              <Stop offset="0.25" stopColor={colors.textOnDark} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#${fill})`} />
          <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#${shine})`} />
          <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#${limb})`} />
          <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#${shade})`} />
          <Circle cx={d / 2} cy={d / 2} r={d / 2 - 0.75} fill="none" stroke={`url(#${rim})`} strokeWidth={1.5} />
        </Svg>
        <FadeSwap swapKey={sending ? 'sending' : 'idle'} style={styles.sphereInner}>
          {sending ? (
            <ActivityIndicator size="large" color={colors.textOnDark} style={{ height: size.sosLh }} />
          ) : (
            <Txt style={[styles.sos, { fontSize: size.sos, lineHeight: size.sosLh, letterSpacing: size.sos * 0.08, paddingLeft: size.sos * 0.08 }]}>
              SOS
            </Txt>
          )}
          <Txt style={styles.sphereSub}>{label}</Txt>
        </FadeSwap>
      </PressableScale>
    </View>
  );
}

/** 주기 함수 f(p)(p = (t + offset) mod 1)를 Animated interpolate 범위로 — 원이 끝까지 퍼지면 안쪽에서 다시 시작한다. */
function periodic(offset: number, keys: readonly (readonly [number, number])[]) {
  const at = (p: number) => {
    for (let k = 1; k < keys.length; k++) {
      const [p0, v0] = keys[k - 1];
      const [p1, v1] = keys[k];
      if (p <= p1) return v0 + ((v1 - v0) * (p - p0)) / (p1 - p0);
    }
    return keys[keys.length - 1][1];
  };
  const pts: [number, number][] = [[0, at(offset)]];
  for (const [p, v] of keys) if (p > offset && p < 1) pts.push([p - offset, v]);
  pts.push([1 - offset - 0.0001, at(1)], [1 - offset, at(0)]);
  for (const [p, v] of keys) if (p > 0 && p < offset) pts.push([p - offset + 1, v]);
  pts.push([1, at(offset)]);
  return { inputRange: pts.map((q) => q[0]), outputRange: pts.map((q) => q[1]) };
}

const RIPPLE_MS = 4200;
/** 구 가장자리에서 나와 금방 또렷해졌다가 바깥으로 갈수록 옅어진다 */
const RIPPLE_OPACITY = [
  [0, 0],
  [0.22, 1],
  [0.4, 1],
  [1, 0],
] as const;
/** 세 원의 위상 — 처음 그림이 디자인(240 또렷 · 300 옅게)과 비슷하도록 */
const RIPPLE_PHASES = [0.04, 0.37, 0.7];

/** 동심원 선이 구에서 천천히 퍼져 나간다. 동작 줄이기면 디자인 그대로 두 겹을 멈춰 그린다. */
function Ripples({ size }: { size: Sizes }) {
  const reduced = useReducedMotion();
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: RIPPLE_MS, easing: Easing.linear, useNativeDriver: motion.native }));
    loop.start();
    return () => loop.stop();
  }, [t, reduced]);
  const rings = useMemo(
    () =>
      RIPPLE_PHASES.map((o) => ({
        opacity: t.interpolate(periodic(o, RIPPLE_OPACITY)),
        scale: t.interpolate(periodic(o, [[0, size.sphere / size.ripple], [1, 1]])),
      })),
    [t, size],
  );
  if (reduced) {
    return (
      <>
        {size.rings.map((r, i) => (
          <View key={r} style={[styles.ring, { width: r, height: r, borderRadius: r / 2, opacity: i === 0 ? 1 : 0.4 }]} />
        ))}
      </>
    );
  }
  const r = size.ripple;
  return (
    <>
      {rings.map((ring, i) => (
        <Animated.View
          key={i}
          style={[styles.ring, styles.rippleRing, { width: r, height: r, borderRadius: r / 2, opacity: ring.opacity, transform: [{ scale: ring.scale }] }]}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  glowLayer: { position: 'absolute', top: 0, bottom: 0, overflow: 'hidden', alignItems: 'center', pointerEvents: 'none' },
  head: { alignItems: 'center' },
  pill: { alignSelf: 'center', minHeight: 38, paddingVertical: 8, paddingLeft: 9, paddingRight: 18, gap: 7, boxShadow: PILL_GLOW },
  pillText: { fontSize: 16, lineHeight: 22 },
  title: { ...font.sans(800), letterSpacing: -1, color: colors.textOnDark, textAlign: 'center' },
  question: { ...font.sans(700), fontSize: 18, lineHeight: 26, letterSpacing: -0.4, color: colors.textOnDark, textAlign: 'center' },
  voiceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 22, opacity: DIM.voice },
  voiceText: { ...font.sans(400), fontSize: 13.5, lineHeight: 20, letterSpacing: -0.2, color: colors.textOnDark },
  sosBlock: { alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', borderWidth: 1, borderColor: colors.sosRing },
  rippleRing: { borderWidth: 1.1 },
  sphere: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.sosBottom, boxShadow: SPHERE_GLOW },
  spherePressed: { opacity: 0.92 },
  /** '괜찮아요'를 보내는 동안 — 누를 수 없다 */
  sphereOff: { opacity: 0.6 },
  sphereInner: { alignItems: 'center', gap: 7 },
  sos: { ...font.sans(800), color: colors.textOnDark, textAlign: 'center' },
  sphereSub: { ...font.sans(500), fontSize: 12.5, lineHeight: 18, color: colors.textOnDark, opacity: DIM.sub, textAlign: 'center' },
  spacer: { flexGrow: 1, minHeight: 16 },
  countdown: { marginHorizontal: 4 },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barTrack: { backgroundColor: colors.textOnDark, opacity: DIM.track },
  barFill: { height: 6, backgroundColor: colors.red },
  countRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 10.5 },
  countLeft: { flexShrink: 1 },
  count: { ...font.mono(800), fontSize: 22, lineHeight: 28, color: colors.textOnDark },
  countSkeleton: { marginVertical: 3 },
  unknown: { ...font.sans(600), fontSize: 15, lineHeight: 28, color: colors.textOnDarkMuted },
  hint: { ...font.sans(400), fontSize: 12.5, lineHeight: 18, letterSpacing: -0.2, color: colors.textOnDark, opacity: DIM.hint, textAlign: 'right', flexShrink: 1 },
  footer: { paddingHorizontal: 24, paddingTop: 0 },
  notice: { marginBottom: 12 },
  foot: { ...font.sans(400), fontSize: 12.5, lineHeight: 18, color: colors.textOnDark, opacity: DIM.foot, textAlign: 'center', marginTop: 16 },
});
