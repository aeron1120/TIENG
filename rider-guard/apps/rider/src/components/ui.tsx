import { Pressable, ScrollView, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, radius } from '@/theme';

/** 기본 폰트/색이 적용된 Text. */
export function Txt({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[styles.txt, style]} />;
}

/** 디자인 프레임의 상단 패딩(56px 등)은 상태바 44px 를 포함한 값이라, 실제 inset 으로 바꿔 계산한다. */
const DESIGN_STATUS_BAR = 44;

type ScreenProps = {
  children: React.ReactNode;
  /** 디자인 기준 상단/하단/좌우 패딩 */
  top?: number;
  bottom?: number;
  side?: number;
  gap?: number;
  dark?: boolean;
  /** 하단 탭바처럼 스크롤 영역 밖에 고정할 요소 */
  footer?: React.ReactNode;
};

/** 세로로 쌓이는 화면 틀. 작은 폰에서는 스크롤되고, 큰 폰에서는 <Spacer/> 가 CTA 를 바닥으로 민다. */
export function Screen({ children, top = 52, bottom = 32, side = 20, gap = 16, dark, footer }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const bg = dark ? colors.ink : colors.bg;
  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          gap,
          paddingHorizontal: side,
          paddingTop: insets.top + Math.max(top - DESIGN_STATUS_BAR, 16),
          paddingBottom: (footer ? 0 : insets.bottom) + bottom,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

export const Spacer = () => <View style={{ flexGrow: 1 }} />;

export function Card({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type BadgeTone = 'accent' | 'accentSoft' | 'info' | 'ink' | 'muted';
const badgeTones: Record<BadgeTone, { bg: string; fg: string }> = {
  accent: { bg: colors.accent, fg: colors.textOnDark },
  accentSoft: { bg: colors.accentSoft, fg: colors.accentSoftText },
  info: { bg: colors.infoSoft, fg: colors.infoSoftText },
  ink: { bg: colors.ink, fg: colors.textOnDark },
  muted: { bg: colors.surfaceMuted, fg: colors.textSubtle },
};

export function Badge({ tone, children, style }: { tone: BadgeTone; children: string; style?: StyleProp<ViewStyle> }) {
  const t = badgeTones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }, style]}>
      <Txt style={[styles.badgeText, { color: t.fg }]}>{children}</Txt>
    </View>
  );
}

type ButtonVariant = 'primary' | 'dark' | 'outline' | 'outlineOnDark' | 'light' | 'dashed';
const buttonVariants: Record<ButtonVariant, { container: ViewStyle; text: TextStyle; pressed: ViewStyle }> = {
  primary: { container: { backgroundColor: colors.accent }, text: { color: colors.textOnDark }, pressed: { backgroundColor: colors.accentPressed } },
  dark: { container: { backgroundColor: colors.ink }, text: { color: colors.textOnDark }, pressed: { opacity: 0.85 } },
  outline: {
    container: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.ink },
    text: { color: colors.text },
    pressed: { backgroundColor: colors.surfaceMuted },
  },
  outlineOnDark: {
    container: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.textOnDark },
    text: { color: colors.textOnDark },
    pressed: { backgroundColor: colors.inkRaised },
  },
  light: { container: { backgroundColor: colors.surface }, text: { color: colors.text }, pressed: { backgroundColor: colors.surfaceMuted } },
  dashed: {
    container: { backgroundColor: 'transparent', borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.borderDashed },
    text: { color: colors.text },
    pressed: { backgroundColor: colors.surfaceMuted },
  },
};

type ButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  variant?: ButtonVariant;
  height?: number;
  rounded?: number;
  fontSize?: number;
  weight?: 600 | 700;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export function Button({
  label,
  variant = 'primary',
  height = 58,
  rounded = radius.xl,
  fontSize = 17,
  weight = 700,
  icon,
  style,
  textStyle,
  disabled,
  ...rest
}: ButtonProps) {
  const v = buttonVariants[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      {...rest}
      style={({ pressed }) => [
        styles.button,
        { height, borderRadius: rounded },
        v.container,
        pressed && v.pressed,
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      {icon}
      <Txt style={[font.sans(weight), { fontSize }, v.text, textStyle]}>{label}</Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  txt: { ...font.sans(400), color: colors.text },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
  },
  badge: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: radius.pill },
  badgeText: { ...font.sans(700), fontSize: 12 },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 14 },
});
