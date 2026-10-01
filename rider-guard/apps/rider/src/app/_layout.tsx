import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Redirect, Stack, usePathname, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';

import { ApiError } from '@/api/client';
import { useMe } from '@/api/hooks';
import { homeFor } from '@/auth/AfterSignIn';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { ToastProvider } from '@/components/Toast';
import { SessionServices } from '@/features/SessionServices';
import { colors, shadow } from '@/theme';
import { fontSources } from '@/theme/fonts';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    // 4xx 는 다시 시도해도 같은 결과라 재시도하지 않는다.
    queries: { staleTime: 2_000, retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2 },
  },
});

export default function RootLayout() {
  // Pretendard 5가지 굵기 — 웹은 public/fonts 의 woff2, 네이티브는 assets/fonts 의 otf (theme/fonts)
  const [loaded, error] = useFonts(fontSources);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* 폰트 로드 실패 시에도 시스템 폰트로 앱은 띄운다. */}
        <AppShell fontsReady={loaded || !!error} />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AppShell({ fontsReady }: { fontsReady: boolean }) {
  const { status } = useAuth();
  const pathname = usePathname();
  // 통합 시연(/demo…)은 로그인 없이, 넓은 화면 그대로 — 로그인 복원을 기다리지 않는다
  const demo = pathname === '/demo' || pathname.startsWith('/demo/');
  // 관제·관리자 화면도 넓은 데스크톱 화면 그대로 (폰 폭 프레임 없음)
  const wide = demo || pathname === '/control' || pathname === '/admin';
  const ready = fontsReady && (demo || status !== 'loading');
  // 상태바 글자색 — 어두운 화면(사고 확인·잠금화면 미리보기)만 밝게, 나머지는 밝은 바탕이라 어둡게
  const lightStatusBar = pathname === '/alert' || pathname === '/lockscreen';
  // 넓은 웹 화면에서는 가운데 폰 폭(430) 프레임으로 보여 준다. 390 폭 캡처에서는 켜지지 않는다.
  const { width } = useWindowDimensions();
  const framed = Platform.OS === 'web' && width > 520 && !wide;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;
  if (!demo && status !== 'signedIn' && !['/', '/signup', '/auth/callback', '/emergency'].includes(pathname)) return <Redirect href="/" />;

  return (
    <View style={{ flex: 1, backgroundColor: framed ? colors.webBackdrop : colors.bg }}>
      <View
        style={{
          flex: 1,
          width: '100%',
          maxWidth: Platform.OS === 'web' && !wide ? 430 : undefined,
          alignSelf: 'center',
          backgroundColor: colors.bg,
          overflow: 'hidden',
          boxShadow: framed ? shadow.raised : undefined,
        }}
      >
        {/* 토스트는 Stack 바깥 — 화면을 떠나기 직전에 띄워도 살아 있다 */}
        <ToastProvider>
          <StatusBar style={lightStatusBar ? 'light' : 'dark'} />
          {/*
            전환: 푸시 화면은 안드로이드에서 iOS식 슬라이드(ios_from_right), 웹은 화면 안 Screen enter·FadeIn 이 맡는다.
            탭 화면(home·records·settings)은 replace 깜빡임을 피하려고 전환 없이 바꾸고 화면 안 FadeIn 으로 등장한다.
            모달(contact·invite·emergency)은 아래에서 올라온다.
          */}
          <Stack screenOptions={{ headerShown: false, animation: 'ios_from_right', contentStyle: { backgroundColor: colors.bg } }}>
            <Stack.Screen name="index" options={{ animation: 'none' }} />
            <Stack.Screen name="signup" />
            <Stack.Screen name="auth/callback" options={{ animation: 'none' }} />
            <Stack.Screen name="onboarding" />
            <Stack.Screen name="helmet" />
            <Stack.Screen name="setup" />
            <Stack.Screen name="contact" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="invite" options={{ presentation: 'modal', animation: 'slide_from_bottom', contentStyle: { backgroundColor: colors.surface } }} />
            <Stack.Screen name="home" options={{ animation: 'none' }} />
            <Stack.Screen name="records" options={{ animation: 'none' }} />
            <Stack.Screen name="settings" options={{ animation: 'none' }} />
            <Stack.Screen
              name="alert"
              options={{
                presentation: 'fullScreenModal',
                animation: 'fade_from_bottom',
                gestureEnabled: false,
                contentStyle: { backgroundColor: colors.alertBg },
              }}
            />
            <Stack.Screen name="status" options={{ animation: 'fade', gestureEnabled: false }} />
            {/* 통합 시연 — 로그인 없음, 넓은 화면 */}
            <Stack.Screen name="role" options={{ animation: 'none' }} />
            <Stack.Screen name="control" options={{ animation: 'none' }} />
            <Stack.Screen name="admin" options={{ animation: 'none' }} />
            <Stack.Screen name="demo/index" options={{ animation: 'none' }} />
            <Stack.Screen name="demo/control" options={{ animation: 'none' }} />
            <Stack.Screen name="demo/rider" options={{ animation: 'none' }} />
            <Stack.Screen name="demo/results" options={{ animation: 'none' }} />
            <Stack.Screen name="demo/report" options={{ animation: 'none' }} />
            {/* 비상연락처가 받는 긴급 알림 웹(v3·9) 미리보기 — 흰 바탕 전체 화면. 닫기 버튼이 없어(디자인) iOS 는 쓸어내려 닫는 모달로 */}
            <Stack.Screen
              name="emergency"
              options={{
                presentation: Platform.OS === 'ios' ? 'modal' : 'fullScreenModal',
                animation: 'slide_from_bottom',
                contentStyle: { backgroundColor: colors.surface },
              }}
            />
            {/* 잠금화면 상시 알림(v3·6) 미리보기 — 어두운 전체 화면 */}
            <Stack.Screen
              name="lockscreen"
              options={{ presentation: 'fullScreenModal', animation: 'fade', contentStyle: { backgroundColor: colors.lockBottom } }}
            />
          </Stack>
          {status === 'signedIn' && !demo ? <RoleGate pathname={pathname} /> : null}
        </ToastProvider>
      </View>
    </View>
  );
}

/** 로그인 뒤 어디서 시작하든 역할 밖 화면은 그 역할의 첫 화면으로. 공개 화면(/, 가입, 긴급 미리보기, 시연)은 건드리지 않는다 */
const OPEN_PATHS = ['/', '/signup', '/auth/callback', '/emergency', '/role'];

function RoleGate({ pathname }: { pathname: string }) {
  const { data: me } = useMe();
  if (!me) return null;
  const role = me.role;
  const admin = role === 'admin';
  let to: string | null = null;
  if (!OPEN_PATHS.includes(pathname)) {
    if (!role) to = '/role';
    else if (pathname === '/admin' && !admin) to = homeFor(me);
    else if (pathname === '/control' && role === 'rider') to = homeFor(me);
    // 관제사는 배달기사 화면(보호·기록·설정·사고 확인…)을 쓰지 않는다
    else if (role === 'dispatcher' && pathname !== '/control') to = '/control';
  }
  return (
    <>
      {to ? <Redirect href={to as Href} /> : null}
      {/* 보호 세션·위치·휴대폰 센서·사고 확인 — 배달기사(와 관리자)만 */}
      {role === 'rider' || admin ? <SessionServices /> : null}
    </>
  );
}
