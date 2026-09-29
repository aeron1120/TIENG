// 시작 화면 = 로그인 (v2·1 톤: 로고 줄 · 큰 제목 · 입력칸 · 하단 보라 버튼). 가입 정보·동의는 /onboarding
import type { SocialProvider } from '@rider-guard/contract';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View, type TextInput } from 'react-native';

import { useAuthProviders, useEmailLogin } from '@/api/hooks';
import { AfterSignIn } from '@/auth/AfterSignIn';
import { useAuth } from '@/auth/AuthProvider';
import { Field, Notice, SocialButton } from '@/components/forms';
import { LogoIcon } from '@/components/Icons';
import { Button, FadeIn, Screen, Spacer, Txt, usePressScale } from '@/components/ui';
import { loginWithSocial } from '@/features/socialLogin';
import { colors, font, typography } from '@/theme';

/** 국내 앱 관례대로 카카오 → 네이버 → 구글 */
const SOCIAL_ORDER: SocialProvider[] = ['kakao', 'naver', 'google'];

export default function LoginScreen() {
  const { status } = useAuth();
  // 어디서 로그인했든 여기로 돌아오면 가입 정보 여부에 따라 홈 또는 가입 정보 입력으로 보낸다.
  if (status === 'signedIn') return <AfterSignIn />;
  return <LoginForm />;
}

function LoginForm() {
  const { signIn } = useAuth();
  const providers = useAuthProviders();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const passwordRef = useRef<TextInput>(null);
  const login = useEmailLogin();
  const social = useMutation({
    mutationFn: loginWithSocial,
    onSuccess: (result) => {
      if (result.kind === 'ok') signIn(result.auth.token);
    },
  });

  const busy = login.isPending || social.isPending;
  const filled = !!email.trim() && !!password;
  const socialProviders = SOCIAL_ORDER.filter((p) => providers.data?.social.includes(p));
  const error = login.error ?? social.error;

  const submit = () => {
    // 키보드 '이동'과 버튼이 겹쳐 두 번 보내지 않게
    if (busy || !filled) return;
    social.reset();
    login.mutate({ email: email.trim(), password }, { onSuccess: ({ token }) => signIn(token) });
  };
  // 다시 입력하기 시작하면 지난 오류는 걷어 낸다
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (login.error) login.reset();
  };

  return (
    <Screen top={56} side={24} gap={28} enter="none">
      <FadeIn style={styles.brand}>
        <LogoIcon size={40} />
        <Txt style={styles.brandName}>Rider Guard</Txt>
      </FadeIn>

      <FadeIn delay={40} style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.display}>
          {'달리는 동안\n곁에서 지켜볼게요'}
        </Txt>
        <Txt style={styles.lead}>사고가 감지되면 먼저 라이더님께 묻고, 답이 없을 때만 가까운 사람에게 알려요.</Txt>
      </FadeIn>

      <FadeIn delay={80} style={styles.form}>
        <Field
          label="이메일"
          value={email}
          onChangeText={edit(setEmail)}
          placeholder="rider@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <Field
          ref={passwordRef}
          label="비밀번호"
          value={password}
          onChangeText={edit(setPassword)}
          placeholder="비밀번호를 입력해 주세요"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Notice error={error} />
      </FadeIn>

      <Spacer />

      <FadeIn delay={120} style={styles.actions}>
        <Button label="로그인" loading={login.isPending} disabled={!filled || social.isPending} onPress={submit} />
        <SignupLink onPress={() => router.push('/signup')} disabled={busy} />
      </FadeIn>

      {socialProviders.length > 0 && (
        // 제공자 목록은 늦게 올 수 있어 맨 아래에 두고 스르르 나타나게 — 위의 입력칸은 움직이지 않는다
        <FadeIn style={styles.social}>
          <View style={styles.divider}>
            <View style={styles.rule} />
            <Txt style={styles.dividerText}>또는 SNS 계정으로</Txt>
            <View style={styles.rule} />
          </View>
          {socialProviders.map((p) => (
            <SocialButton
              key={p}
              provider={p}
              disabled={busy}
              onPress={() => {
                login.reset();
                social.mutate(p);
              }}
            />
          ))}
        </FadeIn>
      )}
    </Screen>
  );
}

/** '처음이신가요? 이메일로 가입하기' — 앞은 회색, 뒤는 보라 굵게 */
function SignupLink({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  const press = usePressScale(0.96);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="이메일로 가입하기"
      accessibilityHint="처음이면 이메일과 비밀번호로 계정을 만들어요"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      hitSlop={4}
      style={styles.link}
    >
      <Animated.View style={{ transform: [{ scale: press.scale }] }}>
        <Txt style={styles.linkText}>
          처음이신가요? <Txt style={[styles.linkText, styles.linkStrong]}>이메일로 가입하기</Txt>
        </Txt>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandName: { ...font.sans(700), fontSize: 18, lineHeight: 24, letterSpacing: -0.2, color: colors.text },
  intro: { gap: 8 },
  // v2·1 설명은 15 — lead(16)로 쓰면 '때만'이 다음 줄로 밀린다
  lead: { ...typography.body, color: colors.textMuted },
  form: { gap: 16 },
  actions: { gap: 4 },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', paddingHorizontal: 12 },
  linkText: { fontSize: 14, lineHeight: 20, color: colors.textMuted },
  linkStrong: { ...font.sans(700), color: colors.primaryInk },
  social: { gap: 10, marginTop: -12 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 2 },
  rule: { flex: 1, height: 1, backgroundColor: colors.divider },
  dividerText: { ...typography.small },
});
