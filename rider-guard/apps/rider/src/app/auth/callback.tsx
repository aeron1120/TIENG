// SNS 로그인 후 서버가 돌려보내는 주소 (riderguard://auth/callback?code=…, 웹은 /auth/callback)
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Loading } from '@/auth/AfterSignIn';
import { useAuth } from '@/auth/AuthProvider';
import { ErrorText } from '@/components/forms';
import { Button, Screen, Txt } from '@/components/ui';
import { completeSocialLogin, isAuthPopup } from '@/features/socialLogin';
import { backOr } from '@/lib/nav';
import { font } from '@/theme';

export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const { signIn } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    // 웹 팝업은 결과를 연 창에 넘기고 닫힌다. 안드로이드는 로그인 화면도 같은 코드를 받으므로 한쪽만 교환한다.
    if (isAuthPopup || started.current) return;
    started.current = true;
    completeSocialLogin(params)
      .then((result) => {
        if (result.kind === 'ok') signIn(result.auth.token);
        // 로그인 화면이 가입 정보 여부를 보고 다음 화면으로 보낸다
        backOr('/');
      })
      .catch(setError);
  }, [params, signIn]);

  if (!error) return <Loading />;
  return (
    <Screen top={56} side={24} gap={16}>
      <Txt style={styles.h1}>로그인하지 못했어요</Txt>
      <ErrorText error={error} />
      <Button label="돌아가기" variant="outline" onPress={() => backOr('/')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 22, letterSpacing: -0.4 },
});
