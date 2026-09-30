import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useMe } from '@/api/hooks';
import { Notice } from '@/components/forms';
import { LogoIcon } from '@/components/Icons';
import { Button, FadeIn, Txt } from '@/components/ui';
import { colors, font, motion } from '@/theme';

/**
 * 로그인된 뒤 첫 화면을 고른다 — 가입 정보(이름·휴대폰·동의)를 마쳤으면 홈, 아니면 시작·동의(v3·1).
 * 로그인 화면(/)이 이걸 그리므로, 어디서 로그인하든 '/' 로 돌아오기만 하면 된다.
 */
export function AfterSignIn() {
  const { data: me, error, refetch } = useMe();
  if (me) return <Redirect href={me.onboarded ? '/home' : '/onboarding'} />;
  if (error) return <View style={styles.root}><Notice error={error} onRetry={() => void refetch()} /><Button label="다시 시도" onPress={() => void refetch()} /></View>;
  return <Loading />;
}

/** 스피너를 늦게 켜는 시간 — 금방 끝나는 로딩에서 스피너가 깜빡이지 않게 */
const SPINNER_DELAY = 400;
/** 이만큼 걸리면 이유를 알려 준다 — 운영 API(Render)는 잠들어 있다 깨어나는 데 30초 가까이 걸린다 */
const SLOW_HINT_DELAY = 6_000;

/** 브랜드 로더 (v3 톤: 아스팔트 로고 타일 + 'Rider Guard') — 오래 걸릴 때만 스피너를 켠다 */
export function Loading() {
  const [slow, setSlow] = useState(false);
  const [verySlow, setVerySlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SPINNER_DELAY);
    const u = setTimeout(() => setVerySlow(true), SLOW_HINT_DELAY);
    return () => {
      clearTimeout(t);
      clearTimeout(u);
    };
  }, []);
  return (
    <View style={styles.root} accessibilityLabel="불러오는 중" accessibilityRole="progressbar">
      <FadeIn offset={0} duration={motion.fast} style={styles.stack}>
        <LogoIcon size={44} />
        <Txt style={styles.name}>Rider Guard</Txt>
        <View style={styles.spinner}>{slow && <ActivityIndicator color={colors.asphalt} />}</View>
        {verySlow ? <Txt style={styles.hint}>서버 연결을 기다리고 있어요. 처음 연결은 30초쯤 걸릴 수 있어요.</Txt> : null}
      </FadeIn>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  stack: { alignItems: 'center' },
  name: { ...font.sans(800), fontSize: 18, lineHeight: 24, letterSpacing: -0.4, marginTop: 12, color: colors.text },
  spinner: { height: 24, marginTop: 20, justifyContent: 'center' },
  hint: { ...font.sans(400), fontSize: 13, lineHeight: 19, marginTop: 12, paddingHorizontal: 32, textAlign: 'center', color: colors.textMuted },
});
