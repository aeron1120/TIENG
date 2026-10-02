/**
 * 공통 UI · 모션 계층 (v3 도로 톤 — 아스팔트·콘크리트·연석·차선). 화면은 여기 있는 것들을 조립만 한다.
 * 모든 Animated 는 useNativeDriver: motion.native(웹 false), easing: motion.easeOut 을 쓴다.
 * 입력칸·체크박스·스위치·머리글 같은 폼 요소는 forms.tsx 에 있다.
 */
import { Children, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
  type GestureResponderEvent,
  type PressableProps,
  type ScrollViewProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckIcon, ChevronRightIcon } from '@/components/Icons';
import { colors, font, motion, radius, shadow, typography } from '@/theme';

const isWeb = Platform.OS === 'web';

// ── 글자 ─────────────────────────────────────────────────────

/** 한국어 줄바꿈을 어절 단위로 — 웹은 CSS word-break, iOS 는 lineBreakStrategyIOS */
const webText = isWeb ? ({ wordBreak: 'keep-all' } as TextStyle) : null;

/** 기본 폰트/색이 적용된 Text. */
export function Txt({ style, lineBreakStrategyIOS = 'hangul-word', ...rest }: TextProps) {
  return <Text lineBreakStrategyIOS={lineBreakStrategyIOS} {...rest} style={[styles.txt, webText, style]} />;
}

// ── 모션 줄이기 ───────────────────────────────────────────────

let reduceMotion = false;
let reduceMotionWatching = false;
const reduceMotionListeners = new Set<() => void>();

function setReduceMotion(value: boolean) {
  if (value === reduceMotion) return;
  reduceMotion = value;
  reduceMotionListeners.forEach((l) => l());
}

function subscribeReduceMotion(listener: () => void) {
  reduceMotionListeners.add(listener);
  if (!reduceMotionWatching) {
    reduceMotionWatching = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
    AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
  }
  return () => {
    reduceMotionListeners.delete(listener);
  };
}

/** 기기 설정의 '동작 줄이기'. true 면 등장·맥동·숨쉬기 계열은 애니메이션 없이 최종값으로 그린다. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduceMotion,
    () => reduceMotion,
    () => false,
  );
}

/** 0→1 진행값. skip 이면 처음부터 1. */
function useEnterProgress({ skip, delay = 0, duration }: { skip: boolean; delay?: number; duration: number }) {
  const [progress] = useState(() => new Animated.Value(skip ? 1 : 0));
  useEffect(() => {
    if (skip) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, { toValue: 1, duration, delay, easing: motion.easeOut, useNativeDriver: motion.native });
    anim.start();
    return () => anim.stop();
  }, [progress, skip, delay, duration]);
  return progress;
}

/** 부드럽게 들숨·날숨하는 반복 (맥동 계열 공통) */
const breatheEasing = Easing.inOut(Easing.sin);

/** 0↔1 을 오가는 반복값. active 가 아니거나 동작 줄이기면 0 에 멈춘다. */
function useBreath(active: boolean, duration: number = motion.breathe) {
  const reduced = useReducedMotion();
  const on = active && !reduced;
  const [value] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!on) {
      value.setValue(0);
      return;
    }
    const half = duration / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: half, easing: breatheEasing, useNativeDriver: motion.native }),
        Animated.timing(value, { toValue: 0, duration: half, easing: breatheEasing, useNativeDriver: motion.native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value, on, duration]);
  return value;
}

// ── 화면 틀 ──────────────────────────────────────────────────

/** 디자인 프레임의 상단 패딩(56px 등)은 상태바 44px 를 포함한 값이라, 실제 inset 으로 바꿔 계산한다. */
export const DESIGN_STATUS_BAR = 44;
/** 디자인 프레임 아래 홈 인디케이터 자리 — 하단 버튼 아래 여백 36 = 34 + 2 */
export const DESIGN_HOME_INDICATOR = 34;

/**
 * 디자인 y 좌표(top, 상태바 포함) → 실제 위 여백. 웹은 상태바가 없어 디자인 프레임을 그대로 흉내 낸다(top 그대로).
 * 네이티브는 상태바 inset 아래로 (top - 44), 상태바에 붙지 않게 최소 8.
 */
export function screenTopPadding(top: number, insetTop: number): number {
  return isWeb ? top : insetTop + Math.max(top - DESIGN_STATUS_BAR, 8);
}

type ScreenEnter = 'auto' | 'rise' | 'fade' | 'none';
/** default = 콘크리트 바탕(bg), white = 흰 바탕(연락처 수락 웹·긴급 알림 웹), dark = 사고 확인(alertBg), lock = 잠금화면 아래색 */
export type ScreenTone = 'default' | 'white' | 'dark' | 'lock';

const SCREEN_BG: Record<ScreenTone, string> = { default: colors.bg, white: colors.surface, dark: colors.alertBg, lock: colors.lockBottom };

type ScreenProps = {
  /** A guide can control the existing scroller without adding another scroll container. */
  scrollProps?: ScrollViewProps & { ref?: React.Ref<ScrollView> };
  children: React.ReactNode;
  /** 디자인 기준 상단/하단/좌우 패딩 */
  top?: number;
  bottom?: number;
  side?: number;
  gap?: number;
  tone?: ScreenTone;
  /** 예전 이름 = tone="dark" */
  dark?: boolean;
  /** 하단 탭바·고정 CTA(ScreenFooter)처럼 스크롤 영역 밖에 고정할 요소 */
  footer?: React.ReactNode;
  /**
   * 진입 모션. auto(기본) = 웹은 rise, 네이티브는 none(네이티브 스택 전환이 맡음).
   * rise = 떠오르기(opacity + translateY 12→0, 280ms), fade = opacity 만(160ms).
   * 섹션을 FadeIn 으로 계단식 등장시키는 화면은 none 을 준다.
   */
  enter?: ScreenEnter;
};

/**
 * 세로로 쌓이는 화면 틀. 작은 폰에서는 스크롤되고, 큰 폰에서는 <Spacer/> 가 CTA 를 바닥으로 민다.
 * v3 좌우 여백은 24(홈처럼 넓은 카드 화면은 side={16}).
 */
export function Screen({ children, top = 46, bottom = 32, side = 24, gap = 16, tone, dark, footer, enter = 'auto', scrollProps }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const bg = SCREEN_BG[tone ?? (dark ? 'dark' : 'default')];
  const mode = enter === 'auto' ? (isWeb ? 'rise' : 'none') : enter;
  const progress = useEnterProgress({ skip: mode === 'none' || reduced, duration: mode === 'fade' ? motion.fast : motion.enter });
  const translateY = useMemo(
    () => progress.interpolate({ inputRange: [0, 1], outputRange: [mode === 'rise' ? motion.distance : 0, 0] }),
    [progress, mode],
  );
  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: side,
          paddingTop: screenTopPadding(top, insets.top),
          paddingBottom: (footer ? 0 : insets.bottom) + bottom,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        {...scrollProps}
      >
        <Animated.View style={{ flexGrow: 1, gap, opacity: progress, transform: [{ translateY }] }}>{children}</Animated.View>
      </ScrollView>
      {/* 스크롤한 내용이 상태바 밑으로 비치지 않게 */}
      {insets.top > 0 && <View style={[styles.statusBlind, { height: insets.top, backgroundColor: bg }]} />}
      {footer}
    </View>
  );
}

/** 하단 버튼 아래 여백 — 디자인 36(홈 인디케이터 34 + 2). 웹·아이폰·안드로이드 제스처바 모두 36, 버튼식 내비게이션 바는 그 위로 */
export const footerBottomPadding = (insetBottom: number) => Math.max(insetBottom + 2, DESIGN_HOME_INDICATOR + 2);

/**
 * 스크롤 밖 바닥에 고정하는 CTA 영역. <Screen footer={<ScreenFooter><Button …/></ScreenFooter>}>
 * 홈 인디케이터만큼 아래 여백을 더한다. 좌우 여백 24 (style 로 덮을 수 있다).
 */
export function ScreenFooter({ children, tone = 'default', style }: { children: React.ReactNode; tone?: ScreenTone; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  return <View style={[styles.footer, { paddingBottom: footerBottomPadding(insets.bottom), backgroundColor: SCREEN_BG[tone] }, style]}>{children}</View>;
}

export const Spacer = () => <View style={{ flexGrow: 1 }} />;

// ── 누름 스프링 ───────────────────────────────────────────────

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * 누를 때 살짝 줄었다가 놓으면 튕겨 돌아오는 스케일. 직접 만든 Pressable 안의 Animated.View 에 transform:[{ scale }] 로 건다.
 * in: spring(to, speed 50, bounciness 0) / out: spring(1, speed 20, bounciness 6)
 */
export function usePressScale(to: number = motion.pressScale) {
  const [scale] = useState(() => new Animated.Value(1));
  const onPressIn = useCallback(() => {
    Animated.spring(scale, { toValue: to, ...motion.pressIn, useNativeDriver: motion.native }).start();
  }, [scale, to]);
  const onPressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, ...motion.pressOut, useNativeDriver: motion.native }).start();
  }, [scale]);
  return useMemo(() => ({ scale, onPressIn, onPressOut }), [scale, onPressIn, onPressOut]);
}

type PressableScaleProps = Omit<PressableProps, 'style' | 'children'> & {
  /** 눌렀을 때 크기 (기본 0.98 — 카드·행 전체) */
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
  /** 누르고 있는 동안 덧씌울 스타일 (예: { backgroundColor: colors.surfacePressed }) */
  pressedStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

/** 카드·행 전체를 누르는 영역. 누르면 scaleTo 로 줄고 pressedStyle 이 덧씌워진다. */
export function PressableScale({ scaleTo = 0.98, style, pressedStyle, children, onPressIn, onPressOut, disabled, ...rest }: PressableScaleProps) {
  const press = usePressScale(scaleTo);
  const [pressed, setPressed] = useState(false);
  const inactive = !!disabled;
  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={(e: GestureResponderEvent) => {
        setPressed(true);
        if (!inactive) press.onPressIn();
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        setPressed(false);
        press.onPressOut();
        onPressOut?.(e);
      }}
      style={[style, pressed && !inactive && pressedStyle, { transform: [{ scale: press.scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

// ── 카드 ─────────────────────────────────────────────────────

/**
 * default = 흰 카드(radius 20, 테두리 없음) · outline = 흰 카드 + 1px 테두리(흰 화면 위, v3·9 지도 카드)
 * dark = 아스팔트 카드(v3·8 '지금 단계', radius 20) · notice = 안내 박스 #E6E6E2(radius 16, v3·3·v3·8 주문 문구)
 * muted = 콘크리트 박스(흰 화면 위 묶음, v3·4 '받게 되는 것') · red = 연빨강 박스(v3·9 카운트다운 — 사고 화면만)
 * 예전 이름: navy = dark, soft = notice, danger = red
 */
export type CardTone = 'default' | 'outline' | 'dark' | 'notice' | 'muted' | 'red' | 'navy' | 'soft' | 'danger';

const darkCard = { box: { backgroundColor: colors.asphalt, borderRadius: radius.card }, pressed: { backgroundColor: colors.darkRaised } };
const noticeCard = { box: { backgroundColor: colors.notice, borderRadius: radius.xl }, pressed: { backgroundColor: colors.curb } };
const redCard = { box: { backgroundColor: colors.redSoft, borderRadius: radius.card }, pressed: { backgroundColor: colors.redTrack } };

const cardTones: Record<CardTone, { box: ViewStyle; pressed: ViewStyle }> = {
  default: { box: { backgroundColor: colors.surface, borderRadius: radius.card }, pressed: { backgroundColor: colors.surfacePressed } },
  outline: {
    box: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border },
    pressed: { backgroundColor: colors.surfacePressed },
  },
  dark: darkCard,
  notice: noticeCard,
  muted: { box: { backgroundColor: colors.surfaceMuted, borderRadius: radius.card }, pressed: { backgroundColor: colors.curb } },
  red: redCard,
  navy: darkCard,
  soft: noticeCard,
  danger: redCard,
};

type CardProps = {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  tone?: CardTone;
  /** 있으면 카드 전체가 눌린다 (스케일 0.98, 눌림 배경, accessibilityRole button) */
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

export function Card({ style, children, onPress, disabled, tone = 'default', accessibilityLabel, accessibilityHint }: CardProps) {
  const t = cardTones[tone];
  const cardStyle = [t.box, style];
  if (onPress) {
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        scaleTo={0.98}
        style={cardStyle}
        pressedStyle={t.pressed}
      >
        {children}
      </PressableScale>
    );
  }
  return (
    <View style={cardStyle} accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint}>
      {children}
    </View>
  );
}

/** 카드 안 가로 구분선 (1pt, 연석). inset = 좌우 여백 */
export function Divider({ inset = 0, onDark, style }: { inset?: number; onDark?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, { marginHorizontal: inset, backgroundColor: onDark ? colors.darkTrack : colors.divider }, style]} />;
}

type IconCircleProps = {
  /** 지름 (기본 40) */
  size?: number;
  /** 원 바탕 (기본 #F1F1ED — v3·5 비상연락처 전화 원). 흰 원은 colors.surface */
  color?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * 아이콘·숫자를 담는 원 (v3·5 전화 원 40 · v3·4 흰 원 36 · v3·3 순위 원 28(1순위 아스팔트, 2순위 연석)).
 * <IconCircle size={28} color={colors.asphalt}><Txt style={{ color: colors.textOnDark }}>1</Txt></IconCircle>
 */
export function IconCircle({ size = 40, color = colors.surfaceMuted, children, style }: IconCircleProps) {
  return <View style={[styles.center, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}>{children}</View>;
}

// ── 목록 ─────────────────────────────────────────────────────

/**
 * 흰 카드 안에 ListRow 들을 구분선으로 나눠 담는다 (v2·5 홈 상태 목록, 설정 묶음).
 * <ListGroup><ListRow …/><ListRow …/></ListGroup> — false·null 자식은 건너뛴다.
 */
export function ListGroup({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const rows = Children.toArray(children);
  return (
    <Card style={[styles.listGroup, style]}>
      {rows.map((row, i) => (
        <View key={i}>
          {i > 0 && <Divider inset={ROW_SIDE} />}
          {row}
        </View>
      ))}
    </Card>
  );
}

const ROW_SIDE = 18;

type ListRowProps = {
  /** 왼쪽 아이콘 (보통 20, colors.text) */
  icon?: React.ReactNode;
  /** 문자열이면 본문 15. 굵은 일부가 필요하면 <Txt> 노드를 넘긴다 */
  label: React.ReactNode;
  /** 라벨 아래 보조 줄 (13, textMuted) */
  sub?: React.ReactNode;
  /** 오른쪽 값 (15, textMuted). 문자열이 아니면 그대로 그린다 */
  value?: React.ReactNode;
  /** value 대신 오른쪽에 둘 노드 (배지·스위치·글자 버튼) */
  right?: React.ReactNode;
  /** 오른쪽 끝 > 표시 */
  chevron?: boolean;
  /** 있으면 행 전체가 눌린다 (스케일 0.98 + 눌림 배경) */
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

/** 아이콘 · 라벨 · 값 · > 한 줄. 좌우 여백 18 을 스스로 가지므로 ListGroup 이나 패딩 없는 Card 안에 둔다. */
export function ListRow({ icon, label, sub, value, right, chevron, onPress, disabled, accessibilityLabel, accessibilityHint, style }: ListRowProps) {
  const content = (
    <>
      {icon ? <View style={styles.rowIcon}>{icon}</View> : null}
      <View style={styles.rowMain}>
        {typeof label === 'string' ? <Txt style={typography.body}>{label}</Txt> : label}
        {sub == null ? null : typeof sub === 'string' ? <Txt style={styles.rowSub}>{sub}</Txt> : sub}
      </View>
      {right ?? (value == null ? null : typeof value === 'string' ? <Txt style={styles.rowValue}>{value}</Txt> : value)}
      {chevron ? <ChevronRightIcon size={18} color={colors.textFaint} /> : null}
    </>
  );
  if (onPress) {
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        style={[styles.row, style]}
        pressedStyle={styles.rowPressed}
      >
        {content}
      </PressableScale>
    );
  }
  return (
    <View style={[styles.row, style]} accessibilityLabel={accessibilityLabel}>
      {content}
    </View>
  );
}

// ── 배지 ─────────────────────────────────────────────────────

/**
 * green = 연초록 바탕·초록 글자(✓ 수락함) · neutral = #F1F1ED 바탕·회색 글자(대기)
 * red = 연빨강 바탕·빨강 글자(● 자동 대응 중 — 사고 화면만) · redSolid = 빨강 바탕·흰 글자(강한 충격이 감지됐어요)
 * dark = 아스팔트 바탕·흰 글자(지도 '지금 여기') · white = 흰 바탕·진한 글자(지도 위 '● 보호 중') · onDark = 어두운 바탕 위 옅은 칩
 * 예전 이름: primary=green, danger=red, dangerSolid=redSolid, primarySolid=dark, accent=redSolid, accentSoft=red, info=green, ink=dark, muted=neutral
 */
export type BadgeTone =
  | 'green'
  | 'neutral'
  | 'red'
  | 'redSolid'
  | 'dark'
  | 'white'
  | 'onDark'
  | 'primary'
  | 'danger'
  | 'dangerSolid'
  | 'primarySolid'
  | 'accent'
  | 'accentSoft'
  | 'info'
  | 'ink'
  | 'muted';

type ToneColors = { bg: string; fg: string; dot: string };
const greenTone: ToneColors = { bg: colors.greenSoft, fg: colors.green, dot: colors.green };
const neutralTone: ToneColors = { bg: colors.surfaceMuted, fg: colors.textMuted, dot: colors.textFaint };
const redTone: ToneColors = { bg: colors.redSoft, fg: colors.redInk, dot: colors.red };
const redSolidTone: ToneColors = { bg: colors.red, fg: colors.textOnDark, dot: colors.textOnDark };
const darkTone: ToneColors = { bg: colors.asphalt, fg: colors.textOnDark, dot: colors.greenOnDark };

const badgeTones: Record<BadgeTone, ToneColors> = {
  green: greenTone,
  neutral: neutralTone,
  red: redTone,
  redSolid: redSolidTone,
  dark: darkTone,
  white: { bg: colors.surface, fg: colors.text, dot: colors.green },
  onDark: { bg: colors.onDarkChip, fg: colors.textOnDarkMuted, dot: colors.greenOnDark },
  primary: greenTone,
  danger: redTone,
  dangerSolid: redSolidTone,
  primarySolid: darkTone,
  accent: redSolidTone,
  accentSoft: redTone,
  info: greenTone,
  ink: darkTone,
  muted: neutralTone,
};

type BadgeProps = {
  tone: BadgeTone;
  children: string;
  /** md(기본) = 높이 26, 13 굵게 / sm = 높이 20, 12 / lg = 높이 32, 14 굵게(지도 위 알약·'강한 충격이 감지됐어요') */
  size?: 'sm' | 'md' | 'lg';
  /** 앞에 작은 점 (tone 의 점 색) — '● 자동 대응 중' */
  dot?: boolean;
  /** 앞에 깜빡이는 실시간 점 */
  live?: boolean;
  /** 앞에 체크 표시 — '✓ 수락함' */
  check?: boolean;
  /** 글자 앞에 붙일 다른 노드 */
  leading?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

/** 작은 알약 배지. Pill 은 같은 컴포넌트다. 세로로 쌓이는 곳에서는 늘어나지 않게 style={{ alignSelf: 'flex-start' }} 를 준다. */
export function Badge({ tone, children, size = 'md', dot, live, check, leading, style, textStyle }: BadgeProps) {
  const t = badgeTones[tone];
  const sm = size === 'sm';
  const lg = size === 'lg';
  const dotSize = lg ? 8 : 6;
  return (
    <View style={[styles.badge, sm && styles.badgeSm, lg && styles.badgeLg, { backgroundColor: t.bg }, style]}>
      {live ? (
        <LiveDot color={t.dot} size={dotSize} />
      ) : dot ? (
        <View style={{ width: dotSize, height: dotSize, borderRadius: dotSize / 2, backgroundColor: t.dot }} />
      ) : null}
      {check ? <CheckIcon size={sm ? 11 : lg ? 14 : 13} color={t.fg} strokeWidth={2.6} /> : null}
      {leading}
      <Txt style={[styles.badgeText, sm && styles.badgeTextSm, lg && styles.badgeTextLg, { color: t.fg }, textStyle]}>{children}</Txt>
    </View>
  );
}

export const Pill = Badge;

/**
 * '시뮬레이션' 작은 칩 — v3 디자인 화면에는 붙이지 않는다. 설정의 개발자 영역처럼 디자인에 없는 곳에서만 쓴다.
 * 요란하지 않게 테두리만 있는 회색 글자. 세로로 쌓이는 곳에서는 style={{ alignSelf: 'flex-start' }}.
 */
export function SimBadge({ onDark, label = '시뮬레이션', style }: { onDark?: boolean; label?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      accessibilityLabel={`${label} 값이에요`}
      style={[styles.sim, { borderColor: onDark ? colors.onDarkChip : colors.border }, style]}
    >
      <Txt style={[styles.simText, { color: onDark ? colors.textOnDarkMuted : colors.textMuted }]}>{label}</Txt>
    </View>
  );
}

// ── 맥동 · 헤일로 ─────────────────────────────────────────────

/** 실시간 점 — opacity 1↔0.3, 각 700ms 반복 */
export function LiveDot({ color, size = 6 }: { color: string; size?: number }) {
  const breath = useBreath(true, 1400);
  const opacity = useMemo(() => breath.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }), [breath]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity }}
    />
  );
}

/**
 * 표시등 뒤에서 퍼지거나(ripple) 숨쉬는(breathe) 원. 부모 안에 position absolute 로 겹친다.
 * ripple: 같은 크기의 원이 scale 1→scaleTo, opacity 0.6→0 반복 (작은 점 뒤)
 * breathe: scale 1↔scaleTo, opacity 1↔0.6 을 천천히 (큰 방패 뒤 링)
 * 사용: <View style={{ width: 10, height: 10 }}><PulseHalo size={10} color={colors.primary} /><View style={dot} /></View>
 */
export function PulseHalo({
  size,
  color,
  active = true,
  mode = 'ripple',
  duration,
  scaleTo,
}: {
  size: number;
  color: string;
  active?: boolean;
  mode?: 'ripple' | 'breathe';
  duration?: number;
  scaleTo?: number;
}) {
  const reduced = useReducedMotion();
  const ripple = mode === 'ripple';
  const on = active && !reduced;
  const [progress] = useState(() => new Animated.Value(0));
  const breath = useBreath(active && !ripple, duration ?? motion.breathe);
  useEffect(() => {
    if (!ripple || !on) {
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(progress, { toValue: 1, duration: duration ?? 1400, easing: Easing.out(Easing.quad), useNativeDriver: motion.native }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, on, ripple, duration]);
  const value = ripple ? progress : breath;
  const to = scaleTo ?? (ripple ? 2.4 : 1.06);
  const scale = useMemo(() => value.interpolate({ inputRange: [0, 1], outputRange: [1, to] }), [value, to]);
  const opacity = useMemo(() => value.interpolate({ inputRange: [0, 1], outputRange: ripple ? [0.6, 0] : [1, 0.6] }), [value, ripple]);
  if (ripple && !on) return null;
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.halo,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity, transform: [{ scale }] },
      ]}
    />
  );
}

type IconHaloProps = {
  /** 가운데 원 지름 (기본 104) */
  size?: number;
  /** light = 콘크리트 위 회색 링 두 겹(v3·2 헬멧), dark = 어두운 바탕 위 링 두 겹 */
  variant?: 'light' | 'dark';
  /** 가운데 원 색 (기본 아스팔트) */
  color?: string;
  /** 링 색 바깥→안 순서로 덮어쓰기 */
  rings?: string[];
  /** 링 두께 (기본 18) */
  ringWidth?: number;
  /** 링이 천천히 숨쉰다 (보호 중) */
  breathing?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * 원형 아이콘 + 헤일로 링 두 겹 (v3·2 헬멧: 가운데 아스팔트 104, 링 18 × 2 — 바깥 #E8E8E4, 안 #DFDFDA).
 * 아이콘은 children 으로: <IconHalo breathing><HelmetIcon size={40} color={colors.textOnDark} /></IconHalo>
 */
export function IconHalo({ size, variant = 'light', color = colors.asphalt, rings, ringWidth, breathing, children, style }: IconHaloProps) {
  const dark = variant === 'dark';
  const inner = size ?? 104;
  const ring = ringWidth ?? 18;
  const ringColors = rings ?? (dark ? [colors.darkRaised, colors.darkTrack] : [colors.haloOuter, colors.haloInner]);
  const outer = inner + ring * 2 * ringColors.length;
  const breath = useBreath(!!breathing);
  const scale = useMemo(() => breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1 + 8 / outer] }), [breath, outer]);
  const opacity = useMemo(() => breath.interpolate({ inputRange: [0, 1], outputRange: [1, 0.72] }), [breath]);
  return (
    <View style={[styles.haloBox, { width: outer, height: outer }, style]}>
      <Animated.View accessibilityElementsHidden style={[StyleSheet.absoluteFill, { opacity, transform: [{ scale }] }]}>
        {ringColors.map((c, i) => {
          const d = outer - ring * 2 * i;
          const at = ring * i;
          return <View key={i} style={[styles.ring, { left: at, top: at, width: d, height: d, borderRadius: d / 2, backgroundColor: c }]} />;
        })}
      </Animated.View>
      <View style={[styles.center, { width: inner, height: inner, borderRadius: inner / 2, backgroundColor: color }]}>{children}</View>
    </View>
  );
}

// ── 진행바 ───────────────────────────────────────────────────

type ProgressBarProps = {
  /** 0~1 */
  value: number;
  height?: number;
  /** 어두운 바탕 위 — 채움 흰색, 트랙 darkTrack (빨강 채움은 color={colors.red}) */
  onDark?: boolean;
  color?: string;
  trackColor?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * 가로 진행바. 값이 바뀌면 240ms 로 따라간다 (폭 애니메이션이라 네이티브 드라이버를 쓰지 않는다).
 * 기본 = 아스팔트 채움·연석 트랙. v3·8 = color={colors.red} onDark, v3·9 = color={colors.red} trackColor={colors.redTrack}
 */
export function ProgressBar({ value, height = 5, onDark, color, trackColor, accessibilityLabel, style }: ProgressBarProps) {
  const reduced = useReducedMotion();
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const [anim] = useState(() => new Animated.Value(clamped));
  useEffect(() => {
    if (reduced) {
      anim.setValue(clamped);
      return;
    }
    const a = Animated.timing(anim, { toValue: clamped, duration: motion.base, easing: motion.easeOut, useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [anim, clamped, reduced]);
  const width = useMemo(() => anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), [anim]);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[{ height, borderRadius: height / 2, backgroundColor: trackColor ?? (onDark ? colors.darkTrack : colors.curb), overflow: 'hidden' }, style]}
    >
      <Animated.View style={{ width, height, borderRadius: height / 2, backgroundColor: color ?? (onDark ? colors.textOnDark : colors.asphalt) }} />
    </View>
  );
}

// ── 등장 · 바뀜 ───────────────────────────────────────────────

type FadeInProps = {
  /** 시작 지연(ms). 섹션 계단은 0/40/80/120(motion.stagger 배수), 목록 행은 120 + Math.min(i, 6) * 40 */
  delay?: number;
  /** 아래에서 떠오르는 거리(px). 0 이면 페이드만 */
  offset?: number;
  duration?: number;
  /** false 면 애니메이션 없이 바로 보인다 (FadeSwap 첫 마운트용) */
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

/** 마운트 때 opacity 0→1 + translateY offset→0. */
export function FadeIn({ delay = 0, offset = 8, duration = motion.base, animate = true, style, children }: FadeInProps) {
  const reduced = useReducedMotion();
  const progress = useEnterProgress({ skip: reduced || !animate, delay, duration });
  const translateY = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }), [progress, offset]);
  return <Animated.View style={[style, { opacity: progress, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

/**
 * swapKey 가 바뀔 때마다 내용을 opacity 0→1 + translateY 4→0(200ms)으로 새로 보여 준다.
 * 첫 마운트는 애니메이션 없이 바로 보인다(화면 FadeIn 과 겹치지 않게).
 */
export function FadeSwap({ swapKey, style, children }: { swapKey: string; style?: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const [firstKey] = useState(swapKey);
  const [swapped, setSwapped] = useState(false);
  if (!swapped && swapKey !== firstKey) setSwapped(true);
  return (
    <FadeIn key={swapKey} animate={swapped} offset={4} duration={200} style={style}>
      {children}
    </FadeIn>
  );
}

// ── 스켈레톤 ─────────────────────────────────────────────────

/** 모든 스켈레톤이 같은 박자로 숨쉬도록 값 하나를 함께 쓴다. 보이는 스켈레톤이 없으면 멈춘다. */
const skeletonOpacity = new Animated.Value(1);
let skeletonUsers = 0;
let skeletonLoop: Animated.CompositeAnimation | null = null;

function retainSkeleton() {
  skeletonUsers += 1;
  if (skeletonUsers > 1) return;
  skeletonLoop = Animated.loop(
    Animated.sequence([
      Animated.timing(skeletonOpacity, { toValue: 0.5, duration: 700, easing: breatheEasing, useNativeDriver: motion.native }),
      Animated.timing(skeletonOpacity, { toValue: 1, duration: 700, easing: breatheEasing, useNativeDriver: motion.native }),
    ]),
  );
  skeletonLoop.start();
}

function releaseSkeleton() {
  skeletonUsers = Math.max(0, skeletonUsers - 1);
  if (skeletonUsers > 0) return;
  skeletonLoop?.stop();
  skeletonLoop = null;
  skeletonOpacity.setValue(1);
}

type SkeletonProps = {
  width: DimensionValue;
  height: number;
  radius?: number;
  /** 어두운 카드 위 */
  onDark?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** 불러오는 동안 자리를 잡아 두는 회색 막대. opacity 1↔0.5, 각 700ms. */
export function Skeleton({ width, height, radius: r = radius.sm, onDark, style }: SkeletonProps) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    retainSkeleton();
    return releaseSkeleton;
  }, [reduced]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width, height, borderRadius: r, backgroundColor: onDark ? colors.skeletonOnDark : colors.skeleton },
        !reduced && { opacity: skeletonOpacity },
        style,
      ]}
    />
  );
}

// ── 바텀시트 ─────────────────────────────────────────────────

const SHEET_OFFSET = 400;

type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** 버튼들 — gap 10 으로 제목 아래에 쌓인다 */
  children?: React.ReactNode;
};

/**
 * 아래에서 올라오는 확인 시트. 가림막(scrim)을 누르거나 안드로이드 뒤로가기로 onClose.
 * 닫을 때는 내려가는 애니메이션이 끝난 뒤 언마운트한다. Alert.alert 대신 쓴다(웹에서도 동작).
 */
export function Sheet({ visible, onClose, title, description, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  const [scrim] = useState(() => new Animated.Value(0));
  const [offset] = useState(() => new Animated.Value(SHEET_OFFSET));

  useEffect(() => {
    if (!mounted) return;
    if (visible) {
      if (reduced) {
        scrim.setValue(1);
        offset.setValue(0);
        return;
      }
      const anim = Animated.parallel([
        Animated.timing(scrim, { toValue: 1, duration: 200, easing: motion.easeOut, useNativeDriver: motion.native }),
        Animated.spring(offset, { toValue: 0, speed: 16, bounciness: 0, useNativeDriver: motion.native }),
      ]);
      anim.start();
      return () => anim.stop();
    }
    const anim = Animated.parallel([
      Animated.timing(scrim, { toValue: 0, duration: reduced ? 0 : 200, easing: Easing.out(Easing.quad), useNativeDriver: motion.native }),
      Animated.timing(offset, { toValue: SHEET_OFFSET, duration: reduced ? 0 : 200, easing: Easing.in(Easing.quad), useNativeDriver: motion.native }),
    ]);
    anim.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => anim.stop();
  }, [visible, mounted, reduced, scrim, offset]);

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: scrim }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="닫기" />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: insets.bottom + 20, transform: [{ translateY: offset }] }]}
        >
          <View style={styles.sheetHandle} />
          <Txt accessibilityRole="header" style={styles.sheetTitle}>
            {title}
          </Txt>
          {description ? <Txt style={styles.sheetDescription}>{description}</Txt> : null}
          {children ? <View style={styles.sheetBody}>{children}</View> : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

// ── 버튼 ─────────────────────────────────────────────────────

/**
 * primary = 아스팔트(동의하고 다음·다음·완료·수락할게요) · soft = 연석('인증 요청')
 * white = 흰 바탕 + 1px 테두리('이제 괜찮아요'·'연락이 안 돼요'. 어두운 화면(onDark)에서는 테두리 없이 — v3·7 '괜찮아요')
 * red = 신호 빨강('119 전화'·'확인했어요, 제가 대응할게요' — 사고 화면만) · dashed = 점선('+ 연락처 추가'·개발용)
 * ghost = 글자만(거절하기) · outlineOnDark = 어두운 바탕 위 테두리
 * 예전 이름: dark = primary, danger = red, light = white, outline = white
 */
export type ButtonVariant = 'primary' | 'soft' | 'white' | 'red' | 'dashed' | 'ghost' | 'outlineOnDark' | 'dark' | 'danger' | 'light' | 'outline';

type VariantStyle = {
  container: ViewStyle;
  text: TextStyle & { color: string };
  pressed: ViewStyle;
  /** 비활성 — 흐리게 하지 않고 명확한 회색으로 */
  disabled: { container: ViewStyle; text: TextStyle };
};
const solidDisabled = { container: { backgroundColor: colors.disabledBg }, text: { color: colors.disabledText } };
const primaryVariant: VariantStyle = {
  container: { backgroundColor: colors.asphalt },
  text: { color: colors.textOnDark },
  pressed: { backgroundColor: colors.asphaltPressed },
  disabled: solidDisabled,
};
const whiteVariant: VariantStyle = {
  container: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  text: { color: colors.text },
  pressed: { backgroundColor: colors.surfacePressed },
  disabled: { container: { borderColor: colors.curb }, text: { color: colors.disabledText } },
};
const redVariant: VariantStyle = {
  container: { backgroundColor: colors.red },
  text: { color: colors.textOnDark },
  pressed: { backgroundColor: colors.redPressed },
  disabled: solidDisabled,
};
const buttonVariants: Record<ButtonVariant, VariantStyle> = {
  primary: primaryVariant,
  dark: primaryVariant,
  soft: {
    container: { backgroundColor: colors.curb },
    text: { color: colors.text },
    pressed: { backgroundColor: colors.curbPressed },
    disabled: solidDisabled,
  },
  white: whiteVariant,
  light: whiteVariant,
  outline: whiteVariant,
  red: redVariant,
  danger: redVariant,
  dashed: {
    container: { backgroundColor: 'transparent', borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderDashed },
    text: { color: colors.text },
    pressed: { backgroundColor: colors.surfacePressed },
    disabled: { container: { borderColor: colors.curb }, text: { color: colors.disabledText } },
  },
  ghost: {
    container: { backgroundColor: 'transparent' },
    text: { color: colors.textMuted },
    pressed: { backgroundColor: colors.surfacePressed },
    disabled: { container: {}, text: { color: colors.disabledText } },
  },
  outlineOnDark: {
    container: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.textOnDarkFaint },
    text: { color: colors.textOnDark },
    pressed: { backgroundColor: colors.onDarkPressed },
    disabled: { container: { borderColor: colors.darkTrack }, text: { color: colors.textOnDarkFaint } },
  },
};
/** 어두운 화면 위 비활성 */
const darkDisabled = { container: { backgroundColor: colors.disabledOnDark, borderColor: colors.disabledOnDark }, text: { color: colors.textOnDarkFaint } };

export type ButtonSize = 'xl' | 'lg' | 'md' | 'sm';
/** xl 58(사고 확인 '괜찮아요') · lg 56(화면 하단 CTA) · md 52(나란한 두 버튼·'인증 요청') · sm 40(작은 버튼 '문구 복사') */
const buttonSizes: Record<ButtonSize, { height: number; fontSize: number; weight: 600 | 700; rounded: number }> = {
  xl: { height: 58, fontSize: 18, weight: 700, rounded: radius.button },
  lg: { height: 56, fontSize: 17, weight: 700, rounded: radius.button },
  md: { height: 52, fontSize: 16, weight: 700, rounded: radius.input },
  sm: { height: 40, fontSize: 14, weight: 700, rounded: radius.lg },
};

type ButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  variant?: ButtonVariant;
  /** xl 58 / lg 56(기본) / md 52 / sm 40. height·rounded·fontSize·weight 를 따로 주면 그것이 우선 */
  size?: ButtonSize;
  height?: number;
  rounded?: number;
  fontSize?: number;
  weight?: 600 | 700 | 800;
  /** 요청 중 — 색은 유지하고 라벨 자리에 스피너. 누를 수 없다 */
  loading?: boolean;
  /** 어두운 화면 위에 놓인 버튼 — 흰 버튼 테두리를 없애고 비활성 색을 어두운 회색으로 */
  onDark?: boolean;
  /** 라벨 앞 아이콘 (예: <PhoneIcon size={18} color={colors.textOnDark} />) */
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export function Button({
  label,
  variant = 'primary',
  size = 'lg',
  height,
  rounded,
  fontSize,
  weight,
  loading = false,
  onDark,
  icon,
  style,
  textStyle,
  disabled,
  onPressIn,
  onPressOut,
  accessibilityState,
  ...rest
}: ButtonProps) {
  const v = buttonVariants[variant];
  const s = buttonSizes[size];
  const off = !!disabled && !loading;
  const inactive = !!disabled || loading;
  const disabledLook = onDark && variant !== 'ghost' ? darkDisabled : v.disabled;
  const press = usePressScale(motion.pressScale);
  const [pressed, setPressed] = useState(false);

  // 누른 채로 비활성·로딩이 되면 크기를 되돌린다
  useEffect(() => {
    if (inactive) press.onPressOut();
  }, [inactive, press]);

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...rest}
      accessibilityState={{ ...accessibilityState, disabled: inactive, busy: loading }}
      disabled={inactive}
      onPressIn={(e: GestureResponderEvent) => {
        setPressed(true);
        if (!inactive) press.onPressIn();
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        setPressed(false);
        press.onPressOut();
        onPressOut?.(e);
      }}
      style={[
        styles.button,
        { minHeight: height ?? s.height, borderRadius: rounded ?? s.rounded },
        v.container,
        onDark && variant !== 'outlineOnDark' && styles.noBorder,
        pressed && !inactive && v.pressed,
        off && disabledLook.container,
        style,
        { transform: [{ scale: press.scale }] },
      ]}
    >
      <View style={[styles.buttonContent, loading && styles.hidden]}>
        {icon}
        <Txt style={[font.sans(weight ?? s.weight), styles.buttonLabel, { fontSize: fontSize ?? s.fontSize }, v.text, textStyle, off && disabledLook.text]}>
          {label}
        </Txt>
      </View>
      {loading && (
        <View style={styles.buttonSpinner}>
          <ActivityIndicator size="small" color={v.text.color} />
        </View>
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  txt: { ...font.sans(400), color: colors.text },
  statusBlind: { position: 'absolute', top: 0, left: 0, right: 0, pointerEvents: 'none' },
  footer: { paddingHorizontal: 24, paddingTop: 12, gap: 10 },
  center: { alignItems: 'center', justifyContent: 'center' },
  divider: { height: 1 },
  listGroup: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, paddingVertical: 14, paddingHorizontal: ROW_SIDE },
  rowPressed: { backgroundColor: colors.surfacePressed },
  rowIcon: { width: 22, alignItems: 'center' },
  rowMain: { flex: 1, gap: 2 },
  rowSub: { ...typography.caption },
  rowValue: { fontSize: 15, lineHeight: 22, color: colors.textMuted },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 26, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeSm: { minHeight: 20, paddingVertical: 2, paddingHorizontal: 8, gap: 4 },
  badgeLg: { minHeight: 32, paddingVertical: 6, paddingHorizontal: 12, gap: 7 },
  badgeText: { ...font.sans(700), fontSize: 13, lineHeight: 18 },
  badgeTextSm: { fontSize: 12, lineHeight: 16 },
  badgeTextLg: { fontSize: 14, lineHeight: 20 },
  sim: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: radius.pill, borderWidth: 1 },
  simText: { ...font.sans(600), fontSize: 11, lineHeight: 16 },
  halo: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' },
  haloBox: { alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  ring: { position: 'absolute' },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  noBorder: { borderWidth: 0 },
  buttonContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, flexShrink: 1 },
  buttonLabel: { flexShrink: 1, textAlign: 'center' },
  buttonSpinner: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  hidden: { opacity: 0 },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.panel,
    borderTopRightRadius: radius.panel,
    paddingHorizontal: 20,
    paddingTop: 12,
    boxShadow: shadow.raised,
  },
  sheetHandle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.curb, marginBottom: 18 },
  sheetTitle: { ...font.sans(800), fontSize: 20, lineHeight: 28, letterSpacing: -0.5 },
  sheetDescription: { fontSize: 15, lineHeight: 22, color: colors.textMuted, marginTop: 6 },
  sheetBody: { gap: 10, marginTop: 20 },
});
