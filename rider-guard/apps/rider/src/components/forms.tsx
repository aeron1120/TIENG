import type { SocialProvider } from '@rider-guard/contract';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { errorMessage } from '@/api/client';
import { BackIcon, CheckIcon } from '@/components/Icons';
import { Txt } from '@/components/ui';
import { colors, font, radius, socialColors } from '@/theme';

/** 라벨 + 입력칸 (+ 입력칸 아래 도움말) */
export function Field({ label, hint, ...input }: TextInputProps & { label: string; hint?: string | null }) {
  return (
    <View style={{ gap: 6 }}>
      <Txt style={[font.sans(600), { fontSize: 13 }]}>{label}</Txt>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.borderDashed} {...input} style={[styles.input, input.style]} />
      {hint ? <Txt style={styles.hint}>{hint}</Txt> : null}
    </View>
  );
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="뒤로" onPress={onPress} hitSlop={8} style={styles.back}>
      <BackIcon color={colors.text} />
    </Pressable>
  );
}

/** 밑줄 없는 글자 버튼 (가입하기, 로그아웃 등 보조 동작) */
export function TextButton({ label, onPress, color = colors.textMuted }: { label: string; onPress: () => void; color?: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.textButton, pressed && { opacity: 0.6 }]}>
      <Txt style={[font.sans(600), { fontSize: 14, color }]}>{label}</Txt>
    </Pressable>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <Txt style={styles.error}>{errorMessage(error)}</Txt>;
}

/** 동의 체크 — [필수]/[선택] 꼬리표. 꼬리표가 없으면 굵은 글씨(모두 동의) */
export function Checkbox(props: { checked: boolean; onToggle: () => void; tag?: string; tagColor?: string; label: string }) {
  const { checked, onToggle, tag, tagColor, label } = props;
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={styles.checkRow}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked && <CheckIcon size={14} color={colors.textOnDark} strokeWidth={3.5} />}</View>
      {tag ? (
        <Txt style={styles.checkText}>
          <Txt style={[font.sans(700), { color: tagColor }]}>{tag}</Txt> {label}
        </Txt>
      ) : (
        <Txt style={[styles.checkText, font.sans(700)]}>{label}</Txt>
      )}
    </Pressable>
  );
}

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

/** SNS 로그인 버튼. 색·문구는 각 사 가이드를 따른다. */
export function SocialButton({ provider, onPress, disabled }: { provider: SocialProvider; onPress: () => void; disabled?: boolean }) {
  const c = socialColors[provider];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={SOCIAL_LABEL[provider]}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.social,
        { backgroundColor: c.bg, borderColor: c.border },
        pressed && { opacity: 0.85 },
        disabled && { opacity: 0.5 },
      ]}
    >
      <View style={styles.socialLogo}>
        <SocialLogo provider={provider} />
      </View>
      <Txt style={[font.sans(600), { fontSize: 16, color: c.fg }]}>{SOCIAL_LABEL[provider]}</Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  input: {
    height: 52,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
    ...font.sans(400),
  },
  hint: { fontSize: 12, color: colors.textMuted },
  error: { fontSize: 13, lineHeight: 19, color: colors.accent },
  back: { width: 44, height: 44, marginLeft: -10, alignItems: 'center', justifyContent: 'center' },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', paddingHorizontal: 8 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44 },
  box: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.borderDashed,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkText: { flex: 1, fontSize: 14, lineHeight: 20 },
  social: {
    height: 52,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  // 로고는 왼쪽에 고정하고 문구는 가운데 — 세 버튼의 문구 위치가 맞게
  socialLogo: { position: 'absolute', left: 18 },
});
