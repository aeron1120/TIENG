import { IBMPlexMono_500Medium, IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono';
import {
  IBMPlexSansKR_400Regular,
  IBMPlexSansKR_500Medium,
  IBMPlexSansKR_600SemiBold,
  IBMPlexSansKR_700Bold,
} from '@expo-google-fonts/ibm-plex-sans-kr';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { ApiError } from '@/api/client';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { SessionServices } from '@/features/SessionServices';
import { colors, fontFamilies } from '@/theme';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    // 4xx 는 다시 시도해도 같은 결과라 재시도하지 않는다.
    queries: { staleTime: 2_000, retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2 },
  },
});

export default function RootLayout() {
  const [loaded, error] = useFonts({
    [fontFamilies.sans400]: IBMPlexSansKR_400Regular,
    [fontFamilies.sans500]: IBMPlexSansKR_500Medium,
    [fontFamilies.sans600]: IBMPlexSansKR_600SemiBold,
    [fontFamilies.sans700]: IBMPlexSansKR_700Bold,
    [fontFamilies.mono500]: IBMPlexMono_500Medium,
    [fontFamilies.mono600]: IBMPlexMono_600SemiBold,
  });

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
  const ready = fontsReady && status !== 'loading';

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="signup" />
        <Stack.Screen name="auth/callback" options={{ animation: 'none' }} />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="setup" />
        <Stack.Screen name="contact" options={{ presentation: 'modal' }} />
        <Stack.Screen name="home" options={{ animation: 'none' }} />
        <Stack.Screen name="records" options={{ animation: 'none' }} />
        <Stack.Screen name="settings" options={{ animation: 'none' }} />
        <Stack.Screen
          name="alert"
          options={{ presentation: 'fullScreenModal', gestureEnabled: false, contentStyle: { backgroundColor: colors.ink } }}
        />
        <Stack.Screen name="status" options={{ gestureEnabled: false }} />
      </Stack>
      {status === 'signedIn' && <SessionServices />}
    </>
  );
}
