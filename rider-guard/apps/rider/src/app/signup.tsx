// 이메일 가입 — 가입 뒤 이름·휴대폰·동의는 /onboarding 에서 받는다 (SNS 가입과 같은 흐름)
import { useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { ApiError } from '@/api/client';
import { useEmailSignup } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { Field, Header, Notice } from '@/components/forms';
import { Button, Screen, Spacer, Txt } from '@/components/ui';
import { backOr, resetTo } from '@/lib/nav';
import { typography } from '@/theme';

const MIN_PASSWORD = 8;
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

type FieldKey = 'email' | 'password' | 'confirm';

export default function SignupScreen() {
  const { signIn } = useAuth();
  const signup = useEmailSignup();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // 형식 오류는 칸을 벗어난 뒤에 보여 준다 — 입력 중인 글자마다 빨갛게 되지 않게
  const [touched, setTouched] = useState<Record<FieldKey, boolean>>({ email: false, password: false, confirm: false });
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const touch = (key: FieldKey) => () => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (signup.error) signup.reset();
  };

  const emailError = touched.email && email && !looksLikeEmail(email) ? '이메일 형식을 확인해 주세요.' : null;
  const passwordError = touched.password && password && password.length < MIN_PASSWORD ? `${MIN_PASSWORD}자 이상 입력해 주세요.` : null;
  // 확인 칸은 비밀번호만큼 다 쳤거나 칸을 벗어났을 때만 비교한다
  const confirmError = confirm && confirm !== password && (touched.confirm || confirm.length >= password.length) ? '비밀번호가 서로 달라요.' : null;
  const valid = looksLikeEmail(email) && password.length >= MIN_PASSWORD && confirm === password;
  const emailTaken = signup.error instanceof ApiError && signup.error.code === 'email_taken';

  const submit = () => {
    if (!valid || signup.isPending) return;
    signup.mutate(
      { email: email.trim(), password },
      {
        onSuccess: ({ token }) => {
          signIn(token);
          // 스택을 비우고 가입 정보 입력으로 — 뒤로 가기로 가입 화면에 돌아오지 않게
          resetTo('/onboarding');
        },
      },
    );
  };

  return (
    <Screen top={48} side={24} gap={24}>
      <Header onBack={() => backOr('/')} />

      <View style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.title}>
          이메일로 가입
        </Txt>
        <Txt style={typography.lead}>로그인에 쓸 이메일과 비밀번호를 정해 주세요.</Txt>
      </View>

      <View style={styles.form}>
        <Field
          label="이메일"
          value={email}
          onChangeText={edit(setEmail)}
          onBlur={touch('email')}
          placeholder="rider@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordRef.current?.focus()}
          error={emailError}
        />
        <Field
          ref={passwordRef}
          label="비밀번호"
          value={password}
          onChangeText={edit(setPassword)}
          onBlur={touch('password')}
          placeholder={`${MIN_PASSWORD}자 이상`}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => confirmRef.current?.focus()}
          error={passwordError}
        />
        <Field
          ref={confirmRef}
          label="비밀번호 확인"
          value={confirm}
          onChangeText={edit(setConfirm)}
          onBlur={touch('confirm')}
          placeholder="한 번 더 입력해 주세요"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={submit}
          error={confirmError}
        />
        {/* 이미 가입된 이메일이면 로그인으로 바로 돌아갈 수 있게 */}
        <Notice error={signup.error} onRetry={emailTaken ? () => backOr('/') : undefined} retryLabel="로그인하기" />
      </View>

      <Spacer />

      <Button label="가입하기" loading={signup.isPending} disabled={!valid} onPress={submit} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: 8 },
  form: { gap: 16 },
});
