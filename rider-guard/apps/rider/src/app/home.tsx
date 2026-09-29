// 디자인: spec-v2 05 'v2·5 홈 · 보호 중'. 보호 꺼짐·켜는 중은 같은 히어로 카드의 변형.
// 보호(= 서버 운행 세션)는 헬멧 착용(시뮬레이션)에 따라 SessionServices 가 자동으로 켜고 끈다 — 이 화면에는 시작/종료 버튼이 없다.
import { Redirect, router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useCreateIncident, useMe } from '@/api/hooks';
import { BottomNav } from '@/components/BottomNav';
import { Notice } from '@/components/forms';
import { HelmetIcon, ShieldCheckIcon, ShieldIcon, UsersIcon, WaveformIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, Card, FadeIn, FadeSwap, IconHalo, ListGroup, ListRow, Screen, SimBadge, Skeleton, Txt } from '@/components/ui';
import { useContactAcceptance } from '@/features/contactSim';
import { helmetInfo, useHelmet } from '@/features/helmet';
import { recentLocation, useLocationState } from '@/features/location';
import { batteryText, dayLabel, hm } from '@/lib/format';
import { colors, font, radius, typography } from '@/theme';

// 사고 감지 테스트·헬멧 쓰기/벗기 — 개발 빌드, 또는 시연용 preview 빌드(eas.json 의 EXPO_PUBLIC_SHOW_DEV_TOOLS)에서만
const showDevTools = __DEV__ || process.env.EXPO_PUBLIC_SHOW_DEV_TOOLS === 'true';

/** 배터리가 이 이하면 값을 빨갛게 — 운행 중 꺼지면 감지가 멈춘다 */
const LOW_BATTERY = 20;

/** 히어로 카드 상태. on·held·ending·endFailed 는 세션이 살아 있는 동안(보호 중 모양) */
type HeroKind = 'loading' | 'on' | 'held' | 'ending' | 'endFailed' | 'starting' | 'failed' | 'off';

export default function HomeScreen() {
  // 헬멧 연결·배터리 표시를 위해 홈에 있는 동안 15초마다 새로 받는다.
  const { data: me, error: meError, refetch } = useMe({ refetchInterval: 15_000 });
  const helmet = useHelmet();
  const location = useLocationState();
  const test = useCreateIncident();
  const toast = useToast();
  const acceptance = useContactAcceptance(me?.contacts);

  const active = !!me?.session;
  const { worn } = helmet;
  const kind: HeroKind =
    !me || !helmet.ready
      ? 'loading'
      : active
        ? worn
          ? 'on'
          : helmet.heldByIncident
            ? 'held'
            : helmet.protectionError
              ? 'endFailed'
              : 'ending'
        : worn
          ? helmet.protectionError
            ? 'failed'
            : 'starting'
          : 'off';

  // 보호가 켜지고 꺼지는 순간을 짧게 알린다 — 처음 그릴 때의 상태는 알리지 않는다
  const prevActive = useRef<boolean | null>(null);
  useEffect(() => {
    if (!me) return;
    const was = prevActive.current;
    prevActive.current = active;
    if (was === null || was === active) return;
    if (active) toast.success('보호가 켜졌어요');
    else toast.info('보호가 꺼졌어요');
  }, [me, active, toast]);

  // 가입 정보를 마치지 않았으면 보호를 켤 수 없다 (서버도 403 onboarding_required)
  if (me && !me.onboarded) return <Redirect href="/onboarding" />;

  const loading = !me;
  const info = helmetInfo(me?.device);
  const contacts = me?.contacts ?? [];
  const { accepted, pending, declined } = acceptance.summary;

  // 위치를 못 받으면 사고 때 위치를 알릴 수 없다 — 예전 '위치' 타일 대신 보호 중일 때만 알린다
  const native = Platform.OS !== 'web';
  const locationNote = !active
    ? null
    : location.permission === 'denied'
      ? '위치 권한이 꺼져 있어요. 사고 때 위치를 함께 알릴 수 없어요.'
      : native && location.permission === 'foreground'
        ? '위치는 앱을 켜 둔 동안만 공유돼요. 앱을 닫아도 공유하려면 위치를 "항상 허용"으로 바꿔 주세요.'
        : null;

  const runTest = () => {
    // 지난 실패 문구가 남아 새 요청 결과를 가리지 않게
    test.reset();
    // 사고를 서버에 실제로 만든다. 확인 화면은 SessionServices 가 띄운다.
    test.mutate({ source: 'test', kind: 'impact', location: recentLocation() });
  };

  const contactLabel = contacts.length ? (
    <Txt style={typography.body}>
      비상연락처 <Txt style={font.sans(700)}>{accepted}명 수락</Txt>
      {pending ? ` · ${pending}명 대기` : ''}
      {declined ? ` · ${declined}명 거절` : ''}
    </Txt>
  ) : (
    <Txt style={[typography.bodyStrong, { color: colors.primaryInk }]}>비상연락처를 등록해 주세요</Txt>
  );
  const contactA11y = contacts.length
    ? `비상연락처 ${accepted}명 수락${pending ? `, ${pending}명 대기` : ''}${declined ? `, ${declined}명 거절` : ''}`
    : '비상연락처를 등록해 주세요';

  const lowBattery = info.connected && info.battery != null && info.battery <= LOW_BATTERY;

  return (
    <Screen top={52} bottom={20} gap={18} enter="none" footer={<BottomNav active="home" />}>
      <FadeIn delay={0} style={styles.header}>
        {loading ? (
          <Skeleton width={96} height={22} />
        ) : (
          <Txt accessibilityRole="header" numberOfLines={1} style={[typography.heading, styles.name]}>
            {me.rider.name}님
          </Txt>
        )}
        <Txt style={typography.caption}>{dayLabel()}</Txt>
      </FadeIn>

      <FadeIn delay={40}>
        <Card tone="navy">
          <FadeSwap swapKey={kind}>
            <Hero kind={kind} startedAt={me?.session?.startedAt ?? null} />
          </FadeSwap>
        </Card>
      </FadeIn>

      {loading && meError ? <Notice error={meError} onRetry={() => void refetch()} /> : null}
      {helmet.protectionError && !loading ? (
        <Notice message={`보호를 ${worn ? '켜지' : '끄지'} 못했어요. ${errorMessage(helmet.protectionError)}`} />
      ) : null}

      <FadeIn delay={80}>
        <ListGroup>
          <ListRow
            icon={<HelmetIcon size={20} color={colors.primary} />}
            label={
              loading ? (
                <Skeleton width={104} height={16} />
              ) : (
                <View style={styles.labelRow}>
                  <Txt style={[typography.body, !info.connected && { color: colors.danger }]}>
                    {info.connected ? '헬멧 연결됨' : '헬멧 신호 없음'}
                  </Txt>
                  {/* 실제로 페어링된 기기가 없으면 가상 헬멧이다 */}
                  {info.simulated ? <SimBadge /> : null}
                </View>
              )
            }
            value={
              loading || !info.connected ? undefined : (
                <Txt style={[styles.value, lowBattery && { color: colors.danger }]}>{batteryText(info.battery)}</Txt>
              )
            }
            accessibilityLabel={
              loading ? undefined : info.connected ? `헬멧 연결됨, 배터리 ${batteryText(info.battery)}` : '헬멧 신호 없음'
            }
          />
          <ListRow
            icon={<WaveformIcon size={20} color={colors.primary} />}
            label={
              loading ? (
                <Skeleton width={112} height={16} />
              ) : (
                <View style={styles.labelRow}>
                  <Txt style={typography.body}>{helmet.voice ? '음성 응답 켜짐' : '음성 응답 꺼짐'}</Txt>
                  {/* 실제 헬멧이 붙어 있어도 음성 응답은 아직 흉내 낸 값이다 — 칩은 화면에 한 번만 */}
                  {info.simulated ? null : <SimBadge />}
                </View>
              )
            }
            value={loading || !helmet.voice ? undefined : '헬멧 스피커'}
          />
          <ListRow
            icon={<UsersIcon size={20} color={colors.primary} />}
            label={loading ? <Skeleton width={180} height={16} /> : contactLabel}
            chevron={!loading}
            disabled={loading}
            onPress={() => router.push('/setup')}
            accessibilityLabel={loading ? '비상연락처 불러오는 중' : contactA11y}
            accessibilityHint="비상연락처를 보고 고칠 수 있어요"
          />
        </ListGroup>
      </FadeIn>

      {/* 보호 중인데 위치를 못 받을 때만 — 주인공(히어로·목록)을 가리지 않게 목록 아래에 */}
      {locationNote ? (
        <Notice tone="info" message={locationNote} onRetry={native ? () => void Linking.openSettings() : undefined} retryLabel="설정 열기" />
      ) : null}

      {showDevTools && !loading && (
        <FadeIn delay={120} style={styles.dev}>
          {/* 테스트 사고는 운행 세션이 있어야 만들 수 있다 (서버가 거절) */}
          {active && (
            <Button
              label="개발용 · 사고 감지 테스트"
              variant="dashed"
              height={48}
              rounded={radius.input}
              fontSize={13}
              weight={600}
              style={styles.devDashed}
              textStyle={{ color: colors.textMuted }}
              loading={test.isPending}
              onPress={runTest}
            />
          )}
          <Button
            label={worn ? '개발용 · 헬멧 벗기 (시뮬레이션)' : '개발용 · 헬멧 쓰기 (시뮬레이션)'}
            variant={active ? 'ghost' : 'dashed'}
            height={active ? 44 : 48}
            rounded={radius.input}
            fontSize={13}
            weight={600}
            style={active ? undefined : styles.devDashed}
            textStyle={{ color: colors.textMuted }}
            icon={<HelmetIcon size={16} color={colors.textMuted} />}
            onPress={() => helmet.setWorn(!worn)}
          />
          <Notice error={test.error} />
        </FadeIn>
      )}
    </Screen>
  );
}

/** 히어로 카드 안쪽 — 헤일로 방패 + 상태 제목 + 한 줄 설명. 상태가 바뀌면 FadeSwap 으로 새로 그려진다. */
function Hero({ kind, startedAt }: { kind: HeroKind; startedAt: string | null }) {
  if (kind === 'loading') {
    return (
      <View style={styles.hero}>
        <Skeleton width={HALO} height={HALO} radius={HALO / 2} onDark />
        <View style={styles.heroText}>
          <Skeleton width={112} height={26} onDark style={{ marginVertical: 5 }} />
          <Skeleton width={220} height={14} onDark style={{ marginVertical: 3 }} />
        </View>
      </View>
    );
  }
  const on = kind === 'on' || kind === 'held' || kind === 'ending' || kind === 'endFailed';
  const since = startedAt ? `헬멧 착용 ${hm(startedAt)}부터` : '헬멧 착용 중';
  const { title, sub } = {
    on: { title: '보호 중', sub: `${since} · 앱을 닫아도 계속돼요` },
    held: { title: '보호 중', sub: '사고 대응이 끝나면 보호가 꺼져요' },
    ending: { title: '보호를 끄는 중이에요', sub: '헬멧을 벗었어요' },
    endFailed: { title: '보호 중', sub: '잠시 뒤 자동으로 다시 꺼 볼게요' },
    starting: { title: '보호를 켜는 중이에요', sub: '헬멧 착용을 확인했어요' },
    failed: { title: '보호 꺼짐', sub: '잠시 뒤 자동으로 다시 켜 볼게요' },
    off: { title: '보호 꺼짐', sub: '헬멧을 쓰면 보호가 자동으로 켜져요' },
  }[kind];
  return (
    <View accessible accessibilityLabel={`${title}, ${sub}`} accessibilityLiveRegion="polite" style={styles.hero}>
      {on ? (
        <IconHalo variant="dark" breathing={kind === 'on'}>
          <ShieldCheckIcon size={52} strokeWidth={1.8} color={colors.textOnDark} />
        </IconHalo>
      ) : (
        // 꺼짐은 같은 모양을 흐리게 — 링·원은 남색 계열, 방패는 체크 없이
        <IconHalo variant="dark" color={colors.disabledOnDark} rings={[colors.navyRaised, colors.navyTrack]}>
          <ShieldIcon size={52} strokeWidth={1.8} color={colors.textOnDarkFaint} />
        </IconHalo>
      )}
      <View style={styles.heroText}>
        <Txt style={[typography.title, styles.heroTitle]}>{title}</Txt>
        <Txt style={styles.heroSub}>{sub}</Txt>
      </View>
    </View>
  );
}

/** IconHalo dark 기본 지름 (가운데 108 + 링 10 × 2겹 × 양쪽) */
const HALO = 148;

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 26 },
  name: { flexShrink: 1 },
  hero: { alignItems: 'center', gap: 18, paddingTop: 30, paddingBottom: 26, paddingHorizontal: 20 },
  heroText: { alignItems: 'center', gap: 4 },
  heroTitle: { color: colors.textOnDark, textAlign: 'center' },
  heroSub: { ...font.sans(400), fontSize: 14, lineHeight: 20, color: colors.textOnDarkMuted, textAlign: 'center' },
  labelRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  value: { ...font.sans(400), fontSize: 15, lineHeight: 22, color: colors.textMuted },
  dev: { gap: 8 },
  // 개발용은 디자인처럼 옅은 1pt 점선 — 화면의 주인공이 아니다
  devDashed: { borderWidth: 1 },
});
