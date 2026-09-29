import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useMe } from '@/api/hooks';
import { colors } from '@/theme';

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

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
