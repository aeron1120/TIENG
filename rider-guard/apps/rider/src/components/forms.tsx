/**
 * 폼 · 머리글 요소 (v3). 입력칸 · 체크박스 · 스위치 · 뒤로/닫기 머리글 · 안내 박스 · SNS 버튼.
 * 평소 화면의 오류는 빨강이 아니라 진한 글자 + 경고 삼각형(+ 연석 박스)으로 보인다.
 */
import type { SocialProvider } from '@rider-guard/contract';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { errorMessage } from '@/api/client';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, EyeIcon, EyeOffIcon, InfoIcon, WarningTriangleIcon } from '@/components/Icons';
import { FadeIn, Txt, usePressScale, useReducedMotion } from '@/components/ui';
import { colors, font, motion, radius, shadow, socialColors, typography } from '@/theme';

/** 웹 브라우저 기본 포커스 테두리 끄기 — 대신 아스팔트 테두리를 그린다 */
const webInput = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

// ── 입력칸 ───────────────────────────────────────────────────

type InputProps = TextInputProps & {
  /** 오류 상태 — 아스팔트 테두리 + 옅은 링 (빨강이 아니다) */
  error?: boolean;
  ref?: React.Ref<TextInput>;
};

/**
 * 공통 입력칸 (v3·1: 높이 52, 16px, radius 14, 흰 바탕). 비포커스는 연석 테두리, 포커스는 아스팔트 1.5 테두리.
 * error 면 아스팔트 테두리 + 옅은 링. secureTextEntry 면 오른쪽에 비밀번호 보기 버튼이 붙는다.
 * 숫자 입력은 style={font.mono(500)} (Pretendard 고정폭 숫자).
 */
export function Input({ error, secureTextEntry, style, onFocus, onBlur, ref, ...rest }: InputProps) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const secure = !!secureTextEntry;
  const eye = usePressScale(0.9);
  const input = (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.placeholder}
      selectionColor={colors.asphalt}
      cursorColor={colors.asphalt}
      {...rest}
      secureTextEntry={secure && hidden}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[styles.input, webInput, secure && styles.inputSecure, style, focused && styles.inputFocus, error && styles.inputError]}
    />
  );
  if (!secure) return input;
  return (
    <View style={styles.secureWrap}>
      {input}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={hidden ? '비밀번호 보기' : '비밀번호 숨기기'}
        onPress={() => setHidden((h) => !h)}
        onPressIn={eye.onPressIn}
        onPressOut={eye.onPressOut}
        style={styles.eye}
      >
        <Animated.View style={{ transform: [{ scale: eye.scale }] }}>
          {hidden ? <EyeIcon size={20} color={colors.textMuted} /> : <EyeOffIcon size={20} color={colors.textMuted} />}
        </Animated.View>
      </Pressable>
    </View>
  );
}

type FieldProps = TextInputProps & {
  label: string;
  /** 입력칸 아래 안내 (회색) */
  hint?: string | null;
  /** 형식 오류 — 있으면 hint 대신 경고 삼각형 + 진한 글자로 보이고 입력칸도 오류 상태가 된다 */
  error?: string | null;
  /** 입력칸 오른쪽에 붙일 노드 (v3·1 '인증 요청' 버튼) */
  right?: React.ReactNode;
  ref?: React.Ref<TextInput>;
};

/** 라벨('휴대폰 번호' 13 회색) + 입력칸 (+ 오른쪽 버튼) (+ 입력칸 아래 도움말 또는 오류) */
export function Field({ label, hint, error, right, ref, ...input }: FieldProps) {
  const box = <Input ref={ref} accessibilityLabel={label} {...input} error={!!error} />;
  return (
    <View style={styles.field}>
      <Txt style={typography.label}>{label}</Txt>
      {right ? (
        <View style={styles.fieldRow}>
          <View style={styles.fieldGrow}>{box}</View>
          {right}
        </View>
      ) : (
        box
      )}
      {error ? <FieldError message={error} /> : hint ? <Txt style={styles.hint}>{hint}</Txt> : null}
    </View>
  );
}

/** 입력칸 아래 오류 한 줄 — 경고 삼각형 + 진한 글자 */
function FieldError({ message, onDark }: { message: string; onDark?: boolean }) {
  const color = onDark ? colors.dangerOnDark : colors.error;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.errorRow}>
      <View style={styles.errorIcon}>
        <WarningTriangleIcon size={14} color={color} strokeWidth={2.2} />
      </View>
      <Txt style={[styles.fieldError, { color }]}>{message}</Txt>
    </View>
  );
}

// ── 머리글 ───────────────────────────────────────────────────

type IconButtonProps = {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** 44×44 아이콘 버튼 (뒤로·닫기·더보기). 누르면 0.9 로 줄었다 튕긴다 */
export function IconButton({ label, onPress, children, disabled, style }: IconButtonProps) {
  const press = usePressScale(0.9);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      hitSlop={8}
      style={[styles.iconButton, style]}
    >
      <Animated.View style={{ transform: [{ scale: press.scale }] }}>{children}</Animated.View>
    </Pressable>
  );
}

/** 뒤로 chevron 버튼 (v3·2·v3·3 왼쪽 위) */
export function BackButton({ onPress, onDark }: { onPress: () => void; onDark?: boolean }) {
  return (
    <IconButton label="뒤로" onPress={onPress} style={styles.back}>
      <ChevronLeftIcon color={onDark ? colors.textOnDark : colors.text} />
    </IconButton>
  );
}

type HeaderProps = {
  /** 왼쪽 뒤로 버튼 */
  onBack?: () => void;
  /** 오른쪽 닫기(X) 버튼 */
  onClose?: () => void;
  /** onBack 이 없을 때 왼쪽에 둘 노드 (예: 배지) */
  left?: React.ReactNode;
  /** onClose 가 없을 때 오른쪽에 둘 노드 */
  right?: React.ReactNode;
  closeLabel?: string;
  /** 디자인에 없는 닫기 — 작고 옅게(20, 흐린 글자색) 두어 눈에 덜 띄게 */
  subtleClose?: boolean;
  /** 다크 화면 — 아이콘을 흰색으로 */
  onDark?: boolean;
};

/** 화면 맨 위 44 높이 행 — 뒤로/닫기 버튼. 좌우 -10(뒤로 chevron 은 글리프가 본문 선에 오게 더 뺀다), left/right 노드는 본문 선에 맞춘다 */
export function Header({ onBack, onClose, left, right, closeLabel = '닫기', subtleClose, onDark }: HeaderProps) {
  const iconColor = onDark ? colors.textOnDark : colors.text;
  return (
    <View style={styles.header}>
      {onBack ? (
        <IconButton label="뒤로" onPress={onBack} style={styles.backInHeader}>
          <ChevronLeftIcon color={iconColor} />
        </IconButton>
      ) : left ? (
        <View style={styles.headerSlot}>{left}</View>
      ) : (
        <View />
      )}
      {onClose ? (
        <IconButton label={closeLabel} onPress={onClose}>
          <CloseIcon size={subtleClose ? 20 : 24} color={subtleClose ? colors.textFaint : iconColor} />
        </IconButton>
      ) : right ? (
        <View style={styles.headerSlot}>{right}</View>
      ) : null}
    </View>
  );
}

type StepHeaderProps = {
  /** 없으면 뒤로 버튼 자리를 비운다 */
  onBack?: () => void;
  /** 지금 단계 · 전체 단계 — 오른쪽에 '1 / 2' */
  current?: number;
  total?: number;
  /** current/total 대신 오른쪽에 둘 노드 */
  right?: React.ReactNode;
};

/** 설정 단계 머리글 (v3·2 · v3·3): 왼쪽 뒤로 chevron, 오른쪽 회색 '1 / 2' */
export function StepHeader({ onBack, current, total, right }: StepHeaderProps) {
  const step =
    current != null && total != null ? (
      <Txt accessibilityLabel={`${total}단계 중 ${current}단계`} style={styles.step}>
        {current} / {total}
      </Txt>
    ) : null;
  return <Header onBack={onBack} right={right ?? step} />;
}

type TextButtonProps = {
  label: string;
  onPress: () => void;
  color?: string;
  fontSize?: number;
  weight?: 500 | 600 | 700;
  /** 밑줄 (v3·2 '변경', v3·3 '문자 다시 보내기' — 진한 글자 + 밑줄) */
  underline?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * 글자 버튼 ('거절하기', 로그아웃 등 보조 동작). 누르면 0.96 으로 줄었다 튕긴다.
 * v3 '변경'·'문자 다시 보내기'는 <TextButton label="변경" underline color={colors.text} />
 */
export function TextButton({ label, onPress, color = colors.textMuted, fontSize = 14, weight = 600, underline, disabled, accessibilityLabel, style }: TextButtonProps) {
  const press = usePressScale(0.96);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      hitSlop={6}
      style={[styles.textButton, style]}
    >
      <Animated.View style={{ transform: [{ scale: press.scale }] }}>
        <Txt style={[font.sans(weight), { fontSize, color: disabled ? colors.disabledText : color }, underline && styles.underline]}>{label}</Txt>
      </Animated.View>
    </Pressable>
  );
}

/** 오류 한 줄 — 경고 삼각형 + 진한 글자 (어두운 사고 화면은 onDark) */
export function ErrorText({ error, onDark }: { error: unknown; onDark?: boolean }) {
  if (!error) return null;
  return <FieldError message={errorMessage(error)} onDark={onDark} />;
}

// ── 안내 박스 ────────────────────────────────────────────────

type NoticeProps = {
  /** 오류 객체 — errorMessage(error) 로 문구를 만든다 */
  error?: unknown;
  /** 직접 쓴 문구 — 있으면 error 보다 우선 */
  message?: string;
  /**
   * info = 안내 박스 #E6E6E2 + i (v3·3 '1순위부터 알려요…'은 icon={<ClockIcon …/>})
   * error = 같은 연석 박스 + 경고 삼각형 + 진한 글자 (평소 화면 오류 — 빨강을 쓰지 않는다)
   */
  tone?: 'error' | 'info';
  /** 왼쪽 아이콘 바꾸기 (예: <ClockIcon size={18} color={colors.noticeText} />) */
  icon?: React.ReactNode;
  /** 있으면 오른쪽에 '다시 시도' 글자 버튼 */
  onRetry?: () => void;
  retryLabel?: string;
  /** 어두운 화면(사고 확인) 위 */
  onDark?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** 오류·안내 박스. error·message 가 둘 다 없으면 아무것도 그리지 않는다. */
export function Notice({ error, message, tone = 'error', icon, onRetry, retryLabel = '다시 시도', onDark, style }: NoticeProps) {
  if (!message && !error) return null;
  const text = message ?? errorMessage(error);
  const info = tone === 'info';
  const palette = info
    ? onDark
      ? { bg: colors.alertCard, fg: colors.textOnDarkMuted, icon: colors.textOnDarkMuted, action: colors.textOnDark }
      : { bg: colors.notice, fg: colors.noticeText, icon: colors.noticeText, action: colors.text }
    : onDark
      ? { bg: colors.alertCard, fg: colors.dangerOnDark, icon: colors.dangerOnDark, action: colors.dangerOnDark }
      : { bg: colors.errorSoft, fg: colors.error, icon: colors.error, action: colors.error };
  const Icon = info ? InfoIcon : WarningTriangleIcon;
  return (
    <FadeIn offset={4}>
      <View
        accessibilityRole={info ? undefined : 'alert'}
        accessibilityLiveRegion={info ? undefined : 'polite'}
        style={[styles.notice, { backgroundColor: palette.bg }, style]}
      >
        <View style={styles.noticeIcon}>{icon ?? <Icon size={18} color={palette.icon} />}</View>
        <Txt style={[styles.noticeText, !info && styles.noticeTextError, { color: palette.fg }]}>{text}</Txt>
        {onRetry ? (
          <TextButton label={retryLabel} onPress={onRetry} color={palette.action} fontSize={13} weight={700} underline style={styles.noticeAction} />
        ) : null}
      </View>
    </FadeIn>
  );
}

// ── 체크박스 · 스위치 ────────────────────────────────────────

type CheckboxProps = {
  checked: boolean;
  onToggle: () => void;
  /** 앞 꼬리표 ('필수' 진한 굵게 · '선택' 회색 굵게) */
  tag?: string;
  tagColor?: string;
  label: string;
  /** lg = '모두 동의' 전용 (박스 22, 글자 16 굵게) */
  size?: 'md' | 'lg';
  /** 오른쪽 끝 > (약관 보기). 있으면 > 만 따로 눌린다 */
  onDetail?: () => void;
};

/** 동의 체크 (v3·1) — 아스팔트 둥근 사각 + 흰 체크. 꼬리표가 없으면 굵은 글씨(모두 동의) */
export function Checkbox({ checked, onToggle, tag, tagColor, label, size = 'md', onDetail }: CheckboxProps) {
  const tagTone = tagColor ?? (tag === '선택' ? colors.textFaint : colors.text);
  const lg = size === 'lg';
  const row = usePressScale(0.98);
  const [pop] = useState(() => new Animated.Value(1));
  const mounted = useRef(false);
  // 체크되는 순간 체크 표시가 톡 튄다 (처음 그릴 때는 그대로)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!checked) return;
    pop.setValue(0.6);
    const anim = Animated.spring(pop, { toValue: 1, speed: 30, bounciness: 12, useNativeDriver: motion.native });
    anim.start();
    return () => anim.stop();
  }, [checked, pop]);

  const box = (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={tag ? `${tag.replace(/[[\]]/g, '')}, ${label}` : label}
      onPress={onToggle}
      onPressIn={row.onPressIn}
      onPressOut={row.onPressOut}
      hitSlop={{ top: 4, bottom: 4 }}
      style={styles.checkPress}
    >
      <Animated.View style={[styles.checkRow, lg && styles.checkRowLg, { transform: [{ scale: row.scale }] }]}>
        <View style={[styles.box, lg && styles.boxLg, checked && styles.boxOn]}>
          {checked && (
            <Animated.View style={{ transform: [{ scale: pop }] }}>
              <CheckIcon size={lg ? 15 : 13} color={colors.textOnDark} strokeWidth={3} />
            </Animated.View>
          )}
        </View>
        {tag ? (
          <View style={styles.checkLabelRow}>
            <Txt style={[styles.checkTag, { color: tagTone }]}>{tag}</Txt>
            <Txt style={styles.checkText}>{label}</Txt>
          </View>
        ) : (
          <Txt style={[styles.checkText, styles.checkTextLg]}>{label}</Txt>
        )}
      </Animated.View>
    </Pressable>
  );
  if (!onDetail) return box;
  return (
    <View style={styles.checkWithDetail}>
      {box}
      <IconButton label={`${label} 자세히 보기`} onPress={onDetail} style={styles.checkDetail}>
        <ChevronRightIcon size={16} color={colors.textFaint} />
      </IconButton>
    </View>
  );
}

const TRACK_W = 48;
const TRACK_H = 28;
const THUMB = 22;
const THUMB_TRAVEL = TRACK_W - THUMB - (TRACK_H - THUMB);

type ToggleProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** 스크린리더가 읽을 이름 (예: '말로 응답하기') */
  accessibilityLabel: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** 아스팔트 스위치 (48×28, v3·2 '말로 응답하기'). 손잡이는 스프링으로 미끄러진다 */
export function Toggle({ value, onValueChange, accessibilityLabel, disabled, style }: ToggleProps) {
  const reduced = useReducedMotion();
  const [pos] = useState(() => new Animated.Value(value ? 1 : 0));
  const press = usePressScale(0.94);
  useEffect(() => {
    if (reduced) {
      pos.setValue(value ? 1 : 0);
      return;
    }
    const anim = Animated.spring(pos, { toValue: value ? 1 : 0, speed: 22, bounciness: 4, useNativeDriver: motion.native });
    anim.start();
    return () => anim.stop();
  }, [value, pos, reduced]);
  const translateX = pos.interpolate({ inputRange: [0, 1], outputRange: [0, THUMB_TRAVEL] });
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      hitSlop={8}
      style={[styles.toggleHit, style]}
    >
      <Animated.View
        style={[
          styles.track,
          { backgroundColor: disabled ? colors.disabledBg : value ? colors.asphalt : colors.todo, transform: [{ scale: press.scale }] },
        ]}
      >
        <Animated.View style={[styles.thumb, { transform: [{ translateX }] }]} />
      </Animated.View>
    </Pressable>
  );
}

// ── SNS 로그인 ───────────────────────────────────────────────

const SOCIAL_LABEL: Record<SocialProvider, string> = {
  kakao: '카카오 로그인',
  naver: '네이버 로그인',
  google: 'Google 계정으로 로그인',
};

function SocialLogo({ provider }: { provider: SocialProvider }) {
  if (provider === 'kakao') {
    return (
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path fill="#000000" d="M12 3C6.48 3 2 6.48 2 10.8c0 2.78 1.86 5.22 4.66 6.6l-1.19 4.35c-.1.38.33.68.66.46l5.2-3.45c.22.02.45.03.67.03 5.52 0 10-3.48 10-7.8S17.52 3 12 3z" />
      </Svg>
    );
  }
  if (provider === 'naver') {
    return (
      <Svg width={16} height={16} viewBox="0 0 24 24">
        <Path fill="#FFFFFF" d="M16.27 12.84 7.46 0H0v24h7.73V11.16L16.54 24H24V0h-7.73z" />
      </Svg>
    );
  }
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Path fill="#EA4335" d="M9 3.48c1.69 0 2.83.73 3.48 1.34l2.54-2.48C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l2.91 2.26C4.6 5.05 6.62 3.48 9 3.48z" />
      <Path fill="#4285F4" d="M17.64 9.2c0-.74-.06-1.28-.19-1.84H9v3.34h4.96c-.1.83-.64 2.08-1.84 2.92l2.84 2.2c1.7-1.57 2.68-3.88 2.68-6.66z" />
      <Path fill="#FBBC05" d="M3.88 10.78A5.54 5.54 0 0 1 3.58 9c0-.62.11-1.22.29-1.78L.96 4.96A9.008 9.008 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.92-2.26z" />
      <Path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.84-2.2c-.76.53-1.78.9-3.12.9-2.38 0-4.4-1.57-5.12-3.74L.97 13.04C2.45 15.98 5.48 18 9 18z" />
    </Svg>
  );
}

/** SNS 로그인 버튼. 색·문구는 각 사 가이드를 따른다. 누르면 0.97 로 줄었다 튕긴다 */
export function SocialButton({ provider, onPress, disabled }: { provider: SocialProvider; onPress: () => void; disabled?: boolean }) {
  const c = socialColors[provider];
  const press = usePressScale(motion.pressScale);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={SOCIAL_LABEL[provider]}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
    >
      <Animated.View
        style={[styles.social, { backgroundColor: c.bg, borderColor: c.border }, disabled && styles.socialDisabled, { transform: [{ scale: press.scale }] }]}
      >
        <View style={styles.socialLogo}>
          <SocialLogo provider={provider} />
        </View>
        <Txt style={[font.sans(600), { fontSize: 16, color: c.fg }]}>{SOCIAL_LABEL[provider]}</Txt>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { gap: 8 },
  fieldRow: { flexDirection: 'row', gap: 8 },
  fieldGrow: { flex: 1 },
  input: {
    height: 52,
    paddingHorizontal: 16,
    borderWidth: 1.5,
    borderColor: colors.inputBorder,
    borderRadius: radius.input,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
    ...font.sans(400),
  },
  inputSecure: { paddingRight: 48 },
  inputFocus: { borderColor: colors.asphalt },
  inputError: { borderColor: colors.asphalt, boxShadow: `0 0 0 3px ${colors.errorRing}` },
  secureWrap: { justifyContent: 'center' },
  eye: { position: 'absolute', right: 4, top: 0, bottom: 0, width: 44, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  errorIcon: { paddingTop: 2 },
  fieldError: { ...font.sans(500), flex: 1, fontSize: 13, lineHeight: 18, color: colors.error },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  // chevron 글리프 왼쪽이 본문 선(x 24.5)에 오게 — 44 터치 영역은 그대로 두고 왼쪽으로 뺀다
  back: { marginLeft: -16.5 },
  backInHeader: { marginLeft: -6.5 },
  header: { height: 44, marginHorizontal: -10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSlot: { paddingHorizontal: 10 },
  step: { ...font.sans(600), fontSize: 13, lineHeight: 18, color: colors.textFaint },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', paddingHorizontal: 8 },
  underline: { textDecorationLine: 'underline' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radius.xl },
  noticeIcon: { paddingTop: 2 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 22 },
  noticeTextError: { ...font.sans(500) },
  noticeAction: { minHeight: 22, paddingHorizontal: 0, alignSelf: 'flex-start' },
  checkPress: { flex: 1 },
  checkWithDetail: { flexDirection: 'row', alignItems: 'center' },
  // v3·1 측정: 상자→꼬리표 8.5 · 꼬리표→문구 14 · '모두 동의' 상자→글자 10 · > 는 카드 안쪽 선에 붙는다
  checkDetail: { marginRight: -14 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8.5, minHeight: 44, paddingVertical: 10 },
  checkRowLg: { paddingVertical: 12, gap: 10 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxLg: { width: 22, height: 22, borderRadius: 6 },
  boxOn: { backgroundColor: colors.asphalt, borderColor: colors.asphalt },
  checkLabelRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14 },
  checkTag: { ...font.sans(700), fontSize: 12, lineHeight: 20 },
  checkText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.noticeText },
  checkTextLg: { ...font.sans(700), fontSize: 16, lineHeight: 24, color: colors.text },
  toggleHit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  track: { width: TRACK_W, height: TRACK_H, borderRadius: TRACK_H / 2, padding: (TRACK_H - THUMB) / 2 },
  thumb: { width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: colors.surface, boxShadow: shadow.thumb },
  social: {
    height: 52,
    borderRadius: radius.input,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  socialDisabled: { opacity: 0.5 },
  // 로고는 왼쪽에 고정하고 문구는 가운데 — 세 버튼의 문구 위치가 맞게
  socialLogo: { position: 'absolute', left: 18 },
});
