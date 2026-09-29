// 이메일 가입 (디자인에 없는 화면 — v3·1 톤). 이름은 기기에 잠시 두었다가 시작·동의(v3·1)에서 휴대폰·동의와 함께 가입 정보로 저장한다
import { useRef, useState } from 'react';
import { StyleSheet, type TextInput } from 'react-native';

import { ApiError } from '@/api/client';
import { useEmailSignup } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { Field, Header, Notice } from '@/components/forms';
import { Button, FadeIn, Screen, ScreenFooter, Txt } from '@/components/ui';
import { setPendingName } from '@/features/sim';
import { backOr, resetTo } from '@/lib/nav';
import { typography } from '@/theme';

const MIN_PASSWORD = 8;
/** 서버 가입 정보의 이름 한도와 같다 */
const MAX_NAME = 20;
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

type FieldKey = 'name' | 'email' | 'password' | 'confirm';
const ALL_TOUCHED: Record<FieldKey, boolean> = { name: true, email: true, password: true, confirm: true };

export default function SignupScreen() {
  const { signIn } = useAuth();
  const signup = useEmailSignup();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // 형식 오류는 칸을 벗어난 뒤(또는 '가입하기'를 누른 뒤)에 보여 준다 — 입력 중인 글자마다 오류가 뜨지 않게
  const [touched, setTouched] = useState<Record<FieldKey, boolean>>({ name: false, email: false, password: false, confirm: false });
  const nameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const touch = (key: FieldKey) => () => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (signup.error) signup.reset();
  };

  const problems: Record<FieldKey, string | null> = {
    name: name.trim() ? null : '이름을 입력해 주세요.',
    email: !email.trim() ? '이메일을 입력해 주세요.' : looksLikeEmail(email) ? null : '이메일 형식을 확인해 주세요.',
    password: password.length >= MIN_PASSWORD ? null : `비밀번호는 ${MIN_PASSWORD}자 이상이에요.`,
    confirm: !confirm ? '비밀번호를 한 번 더 입력해 주세요.' : confirm === password ? null : '비밀번호가 서로 달라요.',
  };
  // 확인 칸은 비밀번호만큼 다 쳤을 때도 바로 비교한다
  const shown = (key: FieldKey) =>
    touched[key] || (key === 'confirm' && !!confirm && confirm.length >= password.length) ? problems[key] : null;
  const firstProblem = (Object.keys(problems) as FieldKey[]).find((k) => problems[k]);
  const emailTaken = signup.error instanceof ApiError && signup.error.code === 'email_taken';

  const submit = () => {
    if (signup.isPending) return;
    // 버튼은 늘 아스팔트 — 비어 있거나 틀린 칸이 있으면 모두 알려 주고 첫 칸으로 데려간다
    if (firstProblem) {
      setTouched(ALL_TOUCHED);
      const target = { name: nameRef, email: emailRef, password: passwordRef, confirm: confirmRef }[firstProblem];
      target.current?.focus();
      return;
    }
    signup.mutate(
      { email: email.trim(), password },
      {
        onSuccess: ({ token }) => {
          // 이름은 서버 가입 정보에 아직 넣지 않는다 — 시작·동의(v3·1)가 휴대폰·동의와 함께 저장한다
          setPendingName(name.trim());
          signIn(token);
          // 스택을 비우고 시작·동의로 — 뒤로 가기로 가입 화면에 돌아오지 않게
          resetTo('/onboarding');
        },
      },
    );
  };

  return (
    <Screen
      top={46}
      gap={0}
      bottom={24}
      enter="none"
      footer={
        // 시작·동의(v3·1)의 '동의하고 다음'과 같은 자리 — 가입하고 넘어가도 버튼이 움직이지 않는다
        <ScreenFooter>
          <Button label="가입하기" loading={signup.isPending} onPress={submit} />
        </ScreenFooter>
      }
    >
      <Header onBack={() => backOr('/')} />

      <FadeIn style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.title}>
          {'처음 오셨네요\n계정부터 만들어요'}
        </Txt>
        <Txt style={typography.lead}>{'이름은 사고 때 비상연락처에게 보여요.\n휴대폰 인증과 동의는 다음 화면에서 해요.'}</Txt>
      </FadeIn>

      <FadeIn delay={40} style={styles.form}>
        <Field
          ref={nameRef}
          label="이름"
          value={name}
          onChangeText={edit(setName)}
          onBlur={touch('name')}
          placeholder="이름을 입력해 주세요"
          maxLength={MAX_NAME}
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => emailRef.current?.focus()}
          error={shown('name')}
        />
        <Field
          ref={emailRef}
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
          error={shown('email')}
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
          error={shown('password')}
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
          error={shown('confirm')}
        />
        {/* 이미 가입된 이메일이면 그 이메일을 채운 로그인 화면으로 */}
        <Notice
          error={signup.error}
          onRetry={emailTaken ? () => resetTo({ pathname: '/', params: { email: email.trim() } }) : undefined}
          retryLabel="로그인하기"
        />
      </FadeIn>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // v3·3 처럼 뒤로 줄 아래 16에 제목
  intro: { marginTop: 16, gap: 10 },
  form: { marginTop: 28, gap: 20 },
});
