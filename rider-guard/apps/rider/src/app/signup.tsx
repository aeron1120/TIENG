// 이메일 가입 — 가입 뒤 이름·휴대폰·동의는 /onboarding 에서 받는다 (SNS 가입과 같은 흐름)
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useEmailSignup } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { BackButton, ErrorText, Field } from '@/components/forms';
import { Button, Screen, Spacer, Txt } from '@/components/ui';
import { backOr } from '@/lib/nav';
import { colors, font } from '@/theme';

const MIN_PASSWORD = 8;
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export default function SignupScreen() {
  const { signIn } = useAuth();
  const signup = useEmailSignup();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const emailHint = email && !looksLikeEmail(email) ? '이메일 형식을 확인해 주세요.' : null;
  const passwordHint = password && password.length < MIN_PASSWORD ? `${MIN_PASSWORD}자 이상 입력해 주세요.` : null;
  const confirmHint = confirm && confirm !== password ? '비밀번호가 서로 달라요.' : null;
  const valid = looksLikeEmail(email) && password.length >= MIN_PASSWORD && confirm === password;

  const submit = () =>
    signup.mutate(
      { email: email.trim(), password },
      {
        onSuccess: ({ token }) => {
          signIn(token);
          // 로그인 화면으로 돌아가면 거기서 가입 정보 입력으로 보낸다
          backOr('/');
        },
      },
    );

  return (
    <Screen top={48} side={24} gap={24}>
      <BackButton onPress={() => backOr('/')} />

      <View style={{ gap: 10 }}>
        <Txt style={styles.h1}>이메일로 가입</Txt>
        <Txt style={styles.lead}>로그인에 쓸 이메일과 비밀번호를 정해 주세요.</Txt>
      </View>

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
          hint={emailHint}
        />
        <Field
          label="비밀번호"
          value={password}
          onChangeText={setPassword}
          placeholder={`${MIN_PASSWORD}자 이상`}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          hint={passwordHint}
        />
        <Field
          label="비밀번호 확인"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          hint={confirmHint}
          returnKeyType="go"
          onSubmitEditing={() => valid && submit()}
        />
        <ErrorText error={signup.error} />
      </View>

      <Spacer />

      <Button label={signup.isPending ? '가입 중…' : '가입하기'} disabled={!valid || signup.isPending} onPress={submit} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 26, lineHeight: 34, letterSpacing: -0.5 },
  lead: { fontSize: 15, lineHeight: 23, color: colors.textMuted },
});
