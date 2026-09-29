// 디자인: design/Main.dc.html 의 첫 화면을 로그인으로 바꿨다 (SNS + 이메일). 가입 정보·동의는 /onboarding
import type { SocialProvider } from '@rider-guard/contract';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuthProviders, useEmailLogin } from '@/api/hooks';
import { AfterSignIn } from '@/auth/AfterSignIn';
import { useAuth } from '@/auth/AuthProvider';
import { ErrorText, Field, SocialButton, TextButton } from '@/components/forms';
import { LogoIcon } from '@/components/Icons';
import { Button, Screen, Spacer, Txt } from '@/components/ui';
import { loginWithSocial } from '@/features/socialLogin';
import { colors, font } from '@/theme';

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
  const login = useEmailLogin();
  const social = useMutation({
    mutationFn: loginWithSocial,
    onSuccess: (result) => {
      if (result.kind === 'ok') signIn(result.auth.token);
    },
  });

  const busy = login.isPending || social.isPending;
  const socialProviders = SOCIAL_ORDER.filter((p) => providers.data?.social.includes(p));
  const submit = () => {
    social.reset();
    login.mutate({ email: email.trim(), password }, { onSuccess: ({ token }) => signIn(token) });
  };

  return (
    <Screen top={56} side={24} gap={28}>
      <View style={styles.brand}>
        <LogoIcon />
        <Txt style={styles.brandName}>Rider Guard</Txt>
      </View>

      <View style={{ gap: 10 }}>
        <Txt style={styles.h1}>{'로그인하고\n안전하게 달려요'}</Txt>
        <Txt style={styles.lead}>운행 중 사고가 감지되면 확인 알림을 보내고, 응답이 없으면 비상연락처와 관제센터에 알려요.</Txt>
      </View>

      {socialProviders.length > 0 && (
        <View style={{ gap: 10 }}>
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
          <View style={styles.divider}>
            <View style={styles.rule} />
            <Txt style={styles.dividerText}>또는 이메일로</Txt>
            <View style={styles.rule} />
          </View>
        </View>
      )}

      <View style={{ gap: 14 }}>
        <Field
          label="이메일"
          value={email}
          onChangeText={setEmail}
          placeholder="rider@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
        />
        <Field
          label="비밀번호"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <ErrorText error={login.error ?? social.error} />
      </View>

      <Spacer />

      <View style={{ gap: 6 }}>
        <Button label={login.isPending ? '로그인 중…' : '로그인'} disabled={busy || !email.trim() || !password} onPress={submit} />
        <TextButton label="처음이신가요? 이메일로 가입하기" color={colors.text} onPress={() => router.push('/signup')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandName: { ...font.sans(700), fontSize: 18, letterSpacing: -0.2 },
  h1: { ...font.sans(700), fontSize: 28, lineHeight: 36, letterSpacing: -0.6 },
  lead: { fontSize: 15, lineHeight: 23, color: colors.textMuted },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 },
  rule: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: 13, color: colors.textMuted },
});
