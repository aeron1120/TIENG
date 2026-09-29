import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useMe } from '@/api/hooks';
import { LogoIcon } from '@/components/Icons';
import { FadeIn, Txt } from '@/components/ui';
import { colors, font, motion } from '@/theme';

/**
 * 로그인된 뒤 첫 화면을 고른다 — 가입 정보(이름·휴대폰·동의)를 마쳤으면 홈, 아니면 가입 정보 입력.
 * 로그인 화면(/)이 이걸 그리므로, 어디서 로그인하든 '/' 로 돌아오기만 하면 된다.
 */
export function AfterSignIn() {
  const { data: me, error } = useMe();
  if (me) return <Redirect href={me.onboarded ? '/home' : '/onboarding'} />;
  // 서버에 못 붙으면 홈에서 오류를 보여 주고 다시 시도한다 (홈도 가입 정보를 확인한다)
  if (error) return <Redirect href="/home" />;
  return <Loading />;
}

/** 스피너를 늦게 켜는 시간 — 금방 끝나는 로딩에서 스피너가 깜빡이지 않게 */
const SPINNER_DELAY = 400;

/** 브랜드 로더 — 로고와 이름을 먼저 보이고, 오래 걸릴 때만 스피너를 켠다 */
export function Loading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SPINNER_DELAY);
    return () => clearTimeout(t);
  }, []);
  return (
    <View style={styles.root} accessibilityLabel="불러오는 중" accessibilityRole="progressbar">
      <FadeIn offset={0} duration={motion.fast} style={styles.stack}>
        <LogoIcon size={44} />
        <Txt style={styles.name}>Rider Guard</Txt>
        <View style={styles.spinner}>{slow && <ActivityIndicator color={colors.primary} />}</View>
      </FadeIn>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  stack: { alignItems: 'center' },
  name: { ...font.sans(700), fontSize: 20, lineHeight: 28, letterSpacing: -0.3, marginTop: 12, color: colors.text },
  spinner: { height: 24, marginTop: 20, justifyContent: 'center' },
});
