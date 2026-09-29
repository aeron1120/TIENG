// SNS 로그인 후 서버가 돌려보내는 주소 (riderguard://auth/callback?code=…, 웹은 /auth/callback)
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Loading } from '@/auth/AfterSignIn';
import { useAuth } from '@/auth/AuthProvider';
import { Notice } from '@/components/forms';
import { LogoIcon } from '@/components/Icons';
import { Button, FadeIn, Screen, ScreenFooter, Txt } from '@/components/ui';
import { completeSocialLogin, isAuthPopup } from '@/features/socialLogin';
import { backOr } from '@/lib/nav';
import { colors, font, typography } from '@/theme';

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
  // 로그인 화면과 같은 틀 — 로고 줄 · 큰 제목 · 무채색 오류 박스 · 하단 아스팔트 버튼
  return (
    <Screen
      top={63}
      gap={0}
      bottom={24}
      enter="none"
      footer={
        <ScreenFooter>
          <Button label="로그인 화면으로" onPress={() => backOr('/')} />
        </ScreenFooter>
      }
    >
      <FadeIn style={styles.brand}>
        <LogoIcon size={28} />
        <Txt style={styles.brandName}>Rider Guard</Txt>
      </FadeIn>
      <FadeIn delay={40} style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.title}>
          {'로그인하지\n못했어요'}
        </Txt>
        <Txt style={typography.lead}>{'잠시 뒤 다시 시도하거나\n이메일로 로그인해 주세요.'}</Txt>
      </FadeIn>
      <FadeIn delay={80} style={styles.notice}>
        <Notice error={error} />
      </FadeIn>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandName: { ...font.sans(700), fontSize: 16, lineHeight: 22, letterSpacing: -0.2, color: colors.text },
  intro: { marginTop: 28, gap: 10 },
  notice: { marginTop: 28 },
});
