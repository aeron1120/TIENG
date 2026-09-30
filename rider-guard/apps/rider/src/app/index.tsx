// 시작 화면 = 로그인 (디자인에 없는 화면 — v3·1 톤: 로고 줄 · 큰 제목 · 흰 입력칸 · 하단 아스팔트 버튼). 가입 정보·동의는 /onboarding
import type { SocialProvider } from '@rider-guard/contract';
import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View, type TextInput } from 'react-native';

import { useAuthProviders, useEmailLogin } from '@/api/hooks';
import { AfterSignIn, Loading } from '@/auth/AfterSignIn';
import { useAuth } from '@/auth/AuthProvider';
import { Field, Notice, SocialButton } from '@/components/forms';
import { LogoIcon } from '@/components/Icons';
import { Button, FadeIn, Screen, Spacer, Txt, usePressScale } from '@/components/ui';
import { loginWithSocial } from '@/features/socialLogin';
import { colors, font, typography } from '@/theme';

/** 국내 앱 관례대로 카카오 → 네이버 → 구글 */
const SOCIAL_ORDER: SocialProvider[] = ['kakao', 'naver', 'google'];

export default function LoginScreen() {
  const { status, restoreError, retryRestore, signOut } = useAuth();
  // 어디서 로그인했든 여기로 돌아오면 가입 정보 여부에 따라 홈 또는 가입 정보 입력으로 보낸다.
  if (status === 'signedIn') return <AfterSignIn />;
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <Screen top={63} side={24}><Notice message={restoreError ?? '로그인 상태를 확인할 수 없어요.'} onRetry={() => void retryRestore()} /><Button label="다른 계정으로 로그인" onPress={() => signOut({ tokenInvalid: true })} /></Screen>;
  return <LoginForm />;
}

function LoginForm() {
  const { signIn } = useAuth();
  const providers = useAuthProviders();
  // 가입 화면에서 '이미 가입된 이메일'로 돌아오면 그 이메일을 채워 둔다
  const params = useLocalSearchParams<{ email?: string }>();
  const [prefilled] = useState(() => (typeof params.email === 'string' ? params.email : ''));
  const [email, setEmail] = useState(prefilled);
  const [password, setPassword] = useState('');
  // 빈 칸으로 '로그인'을 누른 뒤에만 칸 아래에 알려 준다
  const [tried, setTried] = useState(false);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const login = useEmailLogin();
  const social = useMutation({
    mutationFn: async (provider: SocialProvider) => {
      const result = await loginWithSocial(provider);
      if (result.kind === 'ok') await signIn(result.auth.token);
      return result;
    },
  });

  const busy = login.isPending || social.isPending || authBusy;
  const socialProviders = SOCIAL_ORDER.filter((p) => p === 'google' || providers.data?.social.includes(p));
  const googleEnabled = !!providers.data?.social.includes('google');
  const error = sessionError ?? login.error ?? social.error;
  const emailMissing = tried && !email.trim() ? '이메일을 입력해 주세요.' : null;
  const passwordMissing = tried && !password ? '비밀번호를 입력해 주세요.' : null;

  const submit = async () => {
    // 키보드 '이동'과 버튼이 겹쳐 두 번 보내지 않게
    if (busy) return;
    // 버튼은 늘 아스팔트 — 빈 칸이 있으면 그 칸으로 데려가 알려 준다
    if (!email.trim() || !password) {
      setTried(true);
      (email.trim() ? passwordRef : emailRef).current?.focus();
      return;
    }
    social.reset();
    setSessionError(null);
    try {
      const { token } = await login.mutateAsync({ email: email.trim(), password });
      setAuthBusy(true);
      await signIn(token);
    } catch (failure) {
      if (!login.error) setSessionError(failure);
    } finally {
      setAuthBusy(false);
    }
  };
  // 다시 입력하기 시작하면 지난 오류는 걷어 낸다
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (login.error) login.reset();
  };

  return (
    <Screen top={63} side={24} gap={0} bottom={16} enter="none">
      <FadeIn style={styles.brand}>
        <LogoIcon size={28} />
        <Txt style={styles.brandName}>Rider Guard</Txt>
      </FadeIn>

      <FadeIn delay={40} style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.display}>
          {'다시 오셨네요\n보호를 이어갈게요'}
        </Txt>
        <Txt style={typography.lead}>{'가입한 이메일로 로그인해 주세요.\n처음이면 아래에서 바로 가입할 수 있어요.'}</Txt>
      </FadeIn>

      <FadeIn delay={80} style={styles.form}>
        <Field
          ref={emailRef}
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
          error={emailMissing}
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
          autoFocus={!!prefilled}
          error={passwordMissing}
        />
        <Notice error={error} />
      </FadeIn>

      <Spacer />

      <FadeIn delay={120} style={styles.actions}>
        <Button label="로그인" loading={login.isPending || authBusy} disabled={social.isPending} onPress={() => void submit()} />
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
              disabled={busy || (p === 'google' && !googleEnabled)}
              onPress={() => {
                login.reset();
                setSessionError(null);
                social.mutate(p);
              }}
            />
          ))}
          {!googleEnabled && <Notice tone="info" message={providers.isError ? 'Google 로그인 설정을 확인할 수 없어요. 네트워크를 확인해 주세요.' : providers.isPending ? 'Google 로그인 설정을 확인하는 중이에요.' : 'Google 로그인이 아직 설정되지 않았어요.'} onRetry={providers.isError ? () => void providers.refetch() : undefined} />}
        </FadeIn>
      )}
    </Screen>
  );
}

/** '처음이신가요? 이메일로 가입하기' — 앞은 회색, 뒤는 진한 굵은 밑줄(v3 글자 링크) */
function SignupLink({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  const press = usePressScale(0.96);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="이메일로 가입하기"
      accessibilityHint="처음이면 이름과 이메일로 계정을 만들어요"
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
  // v3·1 과 같은 자리 — 로고 줄(타일 28 + 'Rider Guard' 16 굵게, 사이 8) · 제목 · 입력칸이 시작·동의 화면과 겹친다
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandName: { ...font.sans(700), fontSize: 16, lineHeight: 22, letterSpacing: -0.2, color: colors.text },
  intro: { marginTop: 28, gap: 10 },
  form: { marginTop: 28, gap: 20 },
  actions: { marginTop: 24, gap: 4 },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', paddingHorizontal: 12 },
  linkText: { fontSize: 14, lineHeight: 20, color: colors.textMuted },
  linkStrong: { ...font.sans(700), color: colors.text, textDecorationLine: 'underline' },
  social: { marginTop: 8, gap: 10 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 2 },
  rule: { flex: 1, height: 1, backgroundColor: colors.divider },
  dividerText: { ...typography.meta },
});
