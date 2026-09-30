// 디자인: spec-v3 05 'v3·5 홈 · 보호 중' — 지도 카드 + 경로형 타임라인 + 헬멧·음성·위치 세 칸, 비상연락처 카드.
// 보호 꺼짐·켜는 중은 디자인에 없어 같은 구조의 변형으로 그린다 (알약 '보호 꺼짐', 지도 흐리게, 착용 시간 '--:--').
// 보호(= 서버 운행 세션)는 헬멧 착용(시뮬레이션)에 따라 SessionServices 가 자동으로 켜고 끈다 — 이 화면에는 시작/종료 버튼이 없다.
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native';
import Svg, { Line as SvgLine } from 'react-native-svg';

import { errorMessage } from '@/api/client';
import { useCreateIncident, useMe } from '@/api/hooks';
import { BottomNav } from '@/components/BottomNav';
import { IconButton, Notice } from '@/components/forms';
import { BellIcon, ClockIcon, HelmetIcon, LockIcon, MapPinIcon, PhoneIcon, ShieldCheckIcon, UsersIcon, WaveformIcon } from '@/components/Icons';
import { MapPill, RiderMap } from '@/components/RiderMap';
import { useToast } from '@/components/Toast';
import { Button, Card, Divider, FadeIn, FadeSwap, IconCircle, Screen, Sheet, Skeleton, Txt } from '@/components/ui';
import { acceptanceSummaryText, useContactAcceptance } from '@/features/contactSim';
import { helmetInfo, helmetStatusText, useHelmet } from '@/features/helmet';
import { recentLocation, useDevicePosition, useLocationState } from '@/features/location';
import { riderDisplayName, useNow, useSimNotifications, wearTime, type SimNotification } from '@/features/sim';
import { timeAgo, timeHM } from '@/lib/format';
import { colors, font, radius, typography } from '@/theme';

// 사고 감지 테스트·헬멧 쓰기/벗기 — 개발 빌드, 또는 시연용 preview 빌드(eas.json 의 EXPO_PUBLIC_SHOW_DEV_TOOLS)에서만
const showDevTools = __DEV__ || process.env.EXPO_PUBLIC_SHOW_DEV_TOOLS === 'true';

/** 화면 상태. on·held·ending·endFailed 는 세션이 살아 있는 동안(보호 중 모양) */
type Kind = 'loading' | 'on' | 'sensorWaiting' | 'sensorStale' | 'held' | 'ending' | 'endFailed' | 'starting' | 'failed' | 'off';

/** 지도 카드 안쪽 여백 — 지도 모서리(radius.card)와 카드 모서리가 동심원이 되게 카드는 radius.card + 이 값 */
const CARD_PAD = 8;
/** 타임라인 점 칸 폭 (점 가운데 = 칸 가운데) */
const RAIL_W = 20;

type Copy = {
  pill: string;
  /** 알약 점 · 둘레 색 */
  dot: string;
  halo: string;
  /** 첫 줄('보호 시작') 제목과 채운 점 여부 */
  first: string;
  firstDone: boolean;
  /** 둘째 줄('지금') 제목 · 보조 줄 */
  now: string;
  sub: string;
  /** 오른쪽 큰 숫자 — null 이면 '--:--' */
  counting: boolean;
};

function copyFor(kind: Exclude<Kind, 'loading'>, startedAt: string | null, address: string): Copy {
  const on = { pill: '보호 중', dot: colors.green, halo: colors.greenSoft, first: startedAt ? `${timeHM(startedAt)} 헬멧 착용` : '헬멧 착용', firstDone: true, now: address, counting: true };
  const off = { dot: colors.textFaint, halo: colors.curb, counting: false };
  switch (kind) {
    case 'on':
      return { ...on, first: startedAt ? `${timeHM(startedAt)} 운행 시작` : '운행 시작', sub: '최근 측정 센서 신호가 확인됐어요' };
    case 'sensorWaiting':
      return { ...off, pill: '센서 정보 대기 중', first: startedAt ? `${timeHM(startedAt)} 운행 시작` : '운행 시작', firstDone: true, now: '첫 센서 측정을 기다리고 있어요', sub: '운행 세션만으로 감지를 확인할 수 없어요' };
    case 'sensorStale':
      return { ...off, pill: '센서 연결 확인 필요', first: startedAt ? `${timeHM(startedAt)} 운행 시작` : '운행 시작', firstDone: true, now: '최근 센서 정보가 없어요', sub: '기기 연결과 측정 전송을 확인해 주세요' };
    case 'held':
      return { ...on, sub: '사고 대응이 끝나면 보호가 꺼져요' };
    case 'ending':
      return { ...on, sub: '헬멧을 벗었어요. 보호를 끄는 중이에요' };
    case 'endFailed':
      return { ...on, sub: '잠시 뒤 자동으로 다시 꺼 볼게요' };
    case 'starting':
      return { ...off, pill: '보호 켜는 중', first: '헬멧 착용 확인', firstDone: true, now: '보호를 켜는 중이에요', sub: '잠시만 기다려 주세요' };
    case 'failed':
      return { ...off, pill: '보호 꺼짐', first: '헬멧 착용 확인', firstDone: true, now: '보호를 켜지 못했어요', sub: '잠시 뒤 자동으로 다시 켜 볼게요' };
    case 'off':
      return { ...off, pill: '보호 꺼짐', first: '헬멧 착용 전', firstDone: false, now: '보호가 꺼져 있어요', sub: '헬멧을 쓰면 보호가 자동으로 켜져요' };
  }
}

export default function HomeScreen() {
  // 헬멧 연결·배터리 표시를 위해 홈에 있는 동안 15초마다 새로 받는다.
  const { data: me, error: meError, refetch } = useMe({ refetchInterval: 15_000 });
  const helmet = useHelmet();
  const location = useLocationState();
  // 지도는 휴대폰·브라우저 자체 GPS 로 '지금 여기'를 띄운다 (헬멧 센서와 무관, 서버로 보내지 않음)
  const gps = useDevicePosition();
  const test = useCreateIncident();
  const toast = useToast();
  const acceptance = useContactAcceptance(me?.contacts);
  const notifications = useSimNotifications(me);

  const sessionActive = !!me?.session;
  const sensorFresh = !!me?.device && !me.device.kind.includes('webcam') && me.device.sensorState === 'fresh' && !!me.device.lastSensorAt;
  const active = sessionActive && sensorFresh;
  const { worn } = helmet;
  const kind: Kind =
    !me || !helmet.ready
      ? 'loading'
      : sessionActive
        ? worn
          ? active ? 'on' : me.device?.sensorState === 'stale' ? 'sensorStale' : 'sensorWaiting'
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
  const loading = kind === 'loading';
  const startedAt = me?.session?.startedAt ?? null;
  // 착용 시간은 1초마다 — 보호 중일 때만 시계를 돌린다
  const now = useNow(1000, active);

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

  // 종 아이콘 알림 목록 — 여는 순간의 목록을 보여 주고, 닫을 때 읽음으로 남긴다
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetItems, setSheetItems] = useState<SimNotification[]>([]);
  const openNotifications = () => {
    setSheetItems(notifications.items);
    setSheetOpen(true);
  };
  const closeNotifications = () => {
    setSheetOpen(false);
    notifications.markSeen();
  };

  // 가입 정보를 마치지 않았으면 보호를 켤 수 없다 (서버도 403 onboarding_required)
  if (me && !me.onboarded) return <Redirect href="/onboarding" />;

  const info = helmetInfo(me?.device, worn);
  const contacts = me?.contacts ?? [];
  const lastLocation = me?.lastLocation;
  const here = gps.fix;
  const known = lastLocation ?? here;
  const address = lastLocation?.address ?? (known ? `${known.lat.toFixed(4)}, ${known.lng.toFixed(4)}` : '위치 기록 없음');
  const mapLabel = here ? '지금 여기' : lastLocation ? `${timeHM(lastLocation.recordedAt)} 마지막 위치` : null;
  // 실제 위치가 없을 때만 — 서울 기본 좌표를 보여 주는 이유를 알린다
  const mapNote = here || lastLocation ? null : gps.status === 'locating' || gps.status === 'idle' ? '위치 찾는 중' : gps.status === 'denied' ? '위치 권한 꺼짐 · 모의 위치' : '모의 지도 위치';
  const copy = loading ? null : copyFor(kind, startedAt, address);

  // 위치를 못 받으면 사고 때 위치를 알릴 수 없다 — 디자인에 없는 안내라 보호 중일 때만.
  // 웹은 거부했을 때만('앱을 켜 둔 동안만'은 브라우저에서 늘 그래서 소음), 네이티브는 '항상 허용'이 아닐 때도
  const native = Platform.OS !== 'web';
  const locationNote = !sessionActive
    ? null
    : location.permission === 'denied'
      ? native
        ? '위치 권한이 꺼져 있어요. 사고 때 위치를 함께 알릴 수 없어요.'
        : '브라우저 위치 권한이 꺼져 있어요. 사고 때 위치를 함께 알릴 수 없어요.'
      : native && location.permission === 'foreground'
        ? '위치는 앱을 켜 둔 동안만 공유돼요. 앱을 닫아도 공유하려면 위치를 "항상 허용"으로 바꿔 주세요.'
        : null;

  const runTest = () => {
    // 지난 실패 문구가 남아 새 요청 결과를 가리지 않게
    test.reset();
    // 사고를 서버에 실제로 만든다. 확인 화면은 SessionServices 가 띄운다.
    test.mutate({ source: 'test', kind: 'impact', location: recentLocation() });
  };

  const contactSummary = acceptanceSummaryText(contacts, acceptance.statusOf);
  const contactTitle = contacts.length ? `비상연락처 ${contacts.length}명` : '비상연락처를 등록해 주세요';
  const contactSub = contacts.length ? contactSummary : '사고 때 1순위부터 차례로 알려요';
  const voiceText = '미지원';
  const helmetText = helmetStatusText(info);
  const wear = copy?.counting ? wearTime(startedAt, now) : kind === 'starting' ? '00:00' : '--:--';

  if (!me && meError) return <Screen top={56} side={16}><Notice error={meError} onRetry={() => void refetch()} /><Button label="다시 시도" onPress={() => void refetch()} /></Screen>;

  return (
    <Screen top={56} side={16} bottom={24} gap={0} enter="none" footer={<BottomNav active="home" />}>
      {/* 인사 + 이름 · 종 */}
      <FadeIn delay={0} style={styles.header}>
        <View style={styles.headerText}>
          <Txt style={styles.hello}>안녕하세요</Txt>
          <TextOr loading={!me} width={112} style={styles.name} accessibilityRole="header" numberOfLines={1}>
            {`${riderDisplayName(me?.rider.name)}님`}
          </TextOr>
        </View>
        <IconButton
          label={notifications.unread ? `알림, 새 알림 ${notifications.unread}개` : '알림'}
          onPress={openNotifications}
          disabled={!me}
          style={styles.bell}
        >
          <BellIcon size={24} color={colors.text} />
        </IconButton>
      </FadeIn>

      {/* 지도 + 경로형 타임라인 + 세 칸 */}
      <FadeIn delay={40} style={styles.mapCardWrap}>
        <Card style={styles.mapCard}>
          <RiderMap
            location={here ?? lastLocation ?? null}
            label={mapLabel}
            height={228}
            radius={radius.card}
            dim={!loading && !active}
            accessibilityLabel={mapLabel ? `지도, ${mapLabel}` : '지도, 위치 기록 없음 · 배경 지도는 모의 위치'}
            topLeft={
              copy ? (
                <FadeSwap swapKey={copy.pill}>
                  <MapPill label={copy.pill} dot={copy.dot} halo={copy.halo} />
                </FadeSwap>
              ) : null
            }
            topRight={mapNote ? <MapPill label={mapNote} /> : null}
            bottomLeft={<MapPill label="동의한 공개 범위에 따라 위치 전달" icon={<LockIcon size={16} color={colors.text} />} />}
          />

          <View style={styles.body}>
            <FadeSwap swapKey={copy ? (copy.counting ? 'on' : kind) : 'loading'}>
              <Timeline copy={copy} wear={wear} />
            </FadeSwap>

            <Divider style={styles.divider} />

            <View style={styles.metrics}>
              <Metric icon={<HelmetIcon size={16} color={colors.textFaint} />} label="헬멧" value={helmetText} loading={loading} width={64} />
              <View style={styles.vline} />
              <Metric icon={<WaveformIcon size={16} color={colors.textFaint} />} label="음성 응답" value={voiceText} loading={loading} width={32} />
              <View style={styles.vline} />
              <Metric icon={<MapPinIcon size={16} color={colors.textFaint} />} label="마지막 위치" value={here ? '지금' : lastLocation ? timeAgo(lastLocation.recordedAt, now) : '기록 없음'} loading={loading} width={60} />
            </View>
          </View>
        </Card>
      </FadeIn>

      {sessionActive && !active && !loading ? <Notice tone="info" message={me?.device?.lastSensorAt ? `최근 센서 측정 ${timeAgo(me.device.lastSensorAt, now)} · ${me.device.staleAfterSeconds ?? 60}초 기준 연결 확인 필요` : '측정된 센서 정보가 없어요. 운행 세션이 있어도 충격 감지를 확인할 수 없어요.'} style={styles.notice} /> : null}
      {helmet.protectionError && !loading ? (
        <Notice message={`보호를 ${worn ? '켜지' : '끄지'} 못했어요. ${errorMessage(helmet.protectionError)}`} style={styles.notice} />
      ) : null}

      {/* 비상연락처 */}
      <FadeIn delay={80} style={styles.contactWrap}>
        <Card
          onPress={() => router.push('/setup')}
          disabled={!me}
          style={styles.contactCard}
          accessibilityLabel={me ? `${contactTitle}. ${contactSub}` : '비상연락처 불러오는 중'}
          accessibilityHint="비상연락처를 보고 고칠 수 있어요"
        >
          <IconCircle size={40}>
            <PhoneIcon size={20} color={colors.text} />
          </IconCircle>
          <View style={styles.contactText}>
            <TextOr loading={!me} width={112} style={styles.contactTitle} numberOfLines={1}>
              {contactTitle}
            </TextOr>
            <TextOr loading={!me} width={176} style={styles.contactSub} numberOfLines={1}>
              {contactSub}
            </TextOr>
          </View>
          {me ? <Txt style={styles.edit}>{contacts.length ? '수정' : '등록'}</Txt> : null}
        </Card>
      </FadeIn>

      {/* 보호 중인데 위치를 못 받을 때만 */}
      {locationNote ? (
        <Notice
          tone="info"
          message={locationNote}
          onRetry={native ? () => void Linking.openSettings() : undefined}
          retryLabel="설정 열기"
          style={styles.notice}
        />
      ) : null}

      {showDevTools && !loading && (
        <FadeIn delay={120} style={styles.dev}>
          {/* 테스트 사고는 운행 세션이 있어야 만들 수 있다 (서버가 거절). 헬멧 벗기는 길게 누르기 · 설정의 '헬멧 착용' */}
          {sessionActive ? (
            <Button
              label="개발용 사고 감지 테스트"
              variant="dashed"
              height={42}
              rounded={radius.xl}
              fontSize={13}
              weight={600}
              textStyle={styles.devText}
              loading={test.isPending}
              onPress={runTest}
              onLongPress={() => helmet.setWorn(false)}
              accessibilityHint="길게 누르면 헬멧을 벗은 것으로 바꿔요"
            />
          ) : (
            <Button
              label={worn ? '개발용 헬멧 벗기' : '개발용 헬멧 쓰기'}
              variant="dashed"
              height={42}
              rounded={radius.xl}
              fontSize={13}
              weight={600}
              textStyle={styles.devText}
              icon={<HelmetIcon size={15} color={colors.textFaint} />}
              onPress={() => helmet.setWorn(!worn)}
            />
          )}
          <Notice error={test.error} />
        </FadeIn>
      )}

      <Sheet visible={sheetOpen} onClose={closeNotifications} title="알림">
        {sheetItems.length ? (
          sheetItems.map((n) => <NotificationRow key={n.id} item={n} />)
        ) : (
          <Txt style={styles.sheetEmpty}>새 알림이 없어요</Txt>
        )}
        <Button label="닫기" variant="soft" size="md" onPress={closeNotifications} style={styles.sheetClose} />
      </Sheet>
    </Screen>
  );
}

// ── 경로형 타임라인 ('보호 시작' ● ┊ ○ '지금') ──

function Timeline({ copy, wear }: { copy: Copy | null; wear: string }) {
  const loading = !copy;
  // 두 점을 잇는 점선 — 줄 높이가 글자에 따라 달라서 두 줄의 가운데를 재서 긋는다
  const [rows, setRows] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const onFirst = useCallback((e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setRows((r) => ({ ...r, a: y + height / 2 }));
  }, []);
  const onNow = useCallback((e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setRows((r) => ({ ...r, b: y + height / 2 }));
  }, []);
  const lineH = rows.a != null && rows.b != null ? rows.b - rows.a : 0;

  return (
    <View>
      {lineH > 0 ? (
        <Svg width={2} height={lineH} style={[styles.railLine, { top: rows.a ?? 0 }]}>
          <SvgLine x1={1} y1={0} x2={1} y2={lineH} stroke={colors.borderDashed} strokeWidth={1.5} strokeDasharray="1.8 2.2" />
        </Svg>
      ) : null}

      <View style={styles.tlRow} onLayout={onFirst}>
        <View style={styles.rail}>
          <View style={[styles.dot, copy?.firstDone ? styles.dotFilled : styles.dotTodo]} />
        </View>
        <View style={styles.tlText} accessible accessibilityLabel={copy ? `보호 시작, ${copy.first}` : undefined}>
          <Txt style={styles.meta}>보호 시작</Txt>
          <TextOr loading={loading} width={124} style={styles.tlTitle} numberOfLines={1}>
            {copy?.first}
          </TextOr>
        </View>
      </View>

      <View style={[styles.tlRow, styles.tlRowNow]} onLayout={onNow}>
        <View style={styles.rail}>
          <View style={[styles.dot, styles.dotNow]} />
        </View>
        <View style={styles.tlText} accessible accessibilityLabel={copy ? `지금, ${copy.now}, ${copy.sub}` : undefined}>
          <Txt style={styles.meta}>지금</Txt>
          <TextOr loading={loading} width={150} style={styles.tlTitle} numberOfLines={2}>
            {copy?.now}
          </TextOr>
          <TextOr loading={loading} width={132} style={styles.tlSub}>
            {copy?.sub}
          </TextOr>
        </View>
        <View style={styles.wear} accessible accessibilityLabel={copy?.counting ? `착용 시간 ${wear}` : '착용 시간 없음'}>
          <TextOr loading={loading} width={68} style={[styles.wearNum, !copy?.counting && styles.wearIdle]}>
            {wear}
          </TextOr>
          <Txt style={[styles.meta, styles.wearLabel]}>착용 시간</Txt>
        </View>
      </View>
    </View>
  );
}

// ── 헬멧 · 음성 응답 · 위치 수집 한 칸 ──

function Metric({ icon, label, value, loading, width }: { icon: React.ReactNode; label: string; value: string; loading: boolean; width: number }) {
  return (
    <View style={styles.metric} accessible accessibilityLabel={loading ? undefined : `${label} ${value}`}>
      <View style={styles.metricHead}>
        {icon}
        <Txt style={styles.meta} numberOfLines={1}>
          {label}
        </Txt>
      </View>
      <TextOr loading={loading} width={width} style={styles.metricValue} numberOfLines={1}>
        {value}
      </TextOr>
    </View>
  );
}

// ── 알림 목록 한 줄 (시뮬레이션) ──

const NOTIF_ICON: Record<SimNotification['kind'], React.ReactNode> = {
  contact: <UsersIcon size={18} color={colors.text} />,
  protection: <ShieldCheckIcon size={18} color={colors.text} />,
  pending: <ClockIcon size={18} color={colors.text} />,
};

function NotificationRow({ item }: { item: SimNotification }) {
  return (
    <View style={styles.notif} accessible accessibilityLabel={`${item.unread ? '새 알림, ' : ''}${item.title}, ${item.body}, ${item.ago}`}>
      <IconCircle size={36}>{NOTIF_ICON[item.kind]}</IconCircle>
      <View style={styles.notifMain}>
        <View style={styles.notifHead}>
          <Txt style={styles.notifTitle} numberOfLines={1}>
            {item.title}
          </Txt>
          {item.unread ? <View style={styles.unread} /> : null}
          <Txt style={styles.notifAgo}>{item.ago}</Txt>
        </View>
        <Txt style={styles.notifBody}>{item.body}</Txt>
      </View>
    </View>
  );
}

// ── 불러오는 동안 글줄 자리를 같은 높이의 스켈레톤으로 ──

type TextOrProps = {
  loading: boolean;
  /** 스켈레톤 폭 */
  width: number;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  accessibilityRole?: 'header';
  children?: React.ReactNode;
};

function TextOr({ loading, width, style, children, ...rest }: TextOrProps) {
  if (loading) {
    const flat = StyleSheet.flatten(style) ?? {};
    const lh = typeof flat.lineHeight === 'number' ? flat.lineHeight : 20;
    return (
      <View style={[styles.skelLine, { height: lh, marginTop: flat.marginTop }]}>
        <Skeleton width={width} height={Math.round(lh * 0.6)} />
      </View>
    );
  }
  return (
    <Txt style={style} {...rest}>
      {children}
    </Txt>
  );
}

const styles = StyleSheet.create({
  // 머리글 — 인사·이름은 카드보다 8 안쪽 (디자인 x 24)
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 8, paddingRight: 4 },
  headerText: { flex: 1, minWidth: 0 },
  hello: { ...font.sans(500), fontSize: 14, lineHeight: 20, letterSpacing: -0.3, color: colors.textMuted },
  name: { ...font.sans(800), fontSize: 24, lineHeight: 30, letterSpacing: -0.8, color: colors.text },
  bell: { backgroundColor: colors.surface, borderRadius: 22 },

  // 지도 카드
  mapCardWrap: { marginTop: 20 },
  mapCard: { padding: CARD_PAD, borderRadius: radius.card + CARD_PAD },
  body: { paddingTop: 23, paddingHorizontal: 12, paddingBottom: 3 },

  // 타임라인
  railLine: { position: 'absolute', left: RAIL_W / 2 - 1 },
  tlRow: { flexDirection: 'row', alignItems: 'center' },
  tlRowNow: { marginTop: 15 },
  rail: { width: RAIL_W, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  dotFilled: { backgroundColor: colors.asphalt },
  dotNow: { backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.asphalt },
  dotTodo: { backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.todo },
  tlText: { flex: 1, minWidth: 0, marginLeft: 10 },
  meta: { ...typography.meta, letterSpacing: -0.3 },
  // 'HH:MM 헬멧 착용' 시각은 고정폭 숫자로 (한글이 섞여도 괜찮다)
  tlTitle: { ...font.sans(700), fontSize: 17, lineHeight: 22, letterSpacing: -0.5, color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] },
  tlSub: { ...font.sans(400), fontSize: 13, lineHeight: 18, letterSpacing: -0.5, color: colors.textMuted },
  wear: { alignItems: 'flex-end', marginLeft: 12 },
  wearNum: { ...font.mono(800), fontSize: 26, lineHeight: 32, letterSpacing: -0.5, color: colors.text, textAlign: 'right' },
  // '--:--' 는 고정폭 숫자 설정이면 줄표 사이가 벌어져 보여서 보통 글꼴로
  wearIdle: { ...font.sans(800), fontVariant: [], letterSpacing: 0, color: colors.textFaint },
  wearLabel: { marginTop: 2 },

  // 세 칸 — 칸 사이 14 + 세로선 (디자인: 세로선 x 121·237)
  divider: { marginTop: 13 },
  metrics: { flexDirection: 'row', columnGap: 14, paddingTop: 10, paddingLeft: 2 },
  metric: { flex: 1, minWidth: 0 },
  metricHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metricValue: { ...font.sans(700), fontSize: 15, lineHeight: 20, letterSpacing: -0.3, color: colors.text, marginTop: 4 },
  vline: { width: 1, marginVertical: 2, backgroundColor: colors.divider },

  // 비상연락처 카드
  contactWrap: { marginTop: 23 },
  contactCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingLeft: 14, paddingRight: 18 },
  contactText: { flex: 1, minWidth: 0, top: 1 },
  contactTitle: { ...font.sans(700), fontSize: 15.5, lineHeight: 20, letterSpacing: -0.5, color: colors.text },
  contactSub: { ...font.sans(400), fontSize: 12.5, lineHeight: 17, letterSpacing: -0.2, color: colors.textMuted, marginTop: 2 },
  edit: { ...font.sans(600), fontSize: 14, lineHeight: 20, letterSpacing: -0.3, color: colors.textMuted },

  notice: { marginTop: 12 },

  // 개발용 — 옅은 1pt 점선, 화면의 주인공이 아니다
  dev: { marginTop: 12, gap: 6 },
  devText: { color: colors.textFaint, letterSpacing: -0.4 },

  // 알림 시트
  notif: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 4 },
  notifMain: { flex: 1, minWidth: 0, gap: 2 },
  notifHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  notifTitle: { ...font.sans(700), fontSize: 15, lineHeight: 20, letterSpacing: -0.3, color: colors.text, flexShrink: 1 },
  unread: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.asphalt },
  notifAgo: { ...typography.meta, marginLeft: 'auto' },
  notifBody: { ...typography.caption },
  sheetEmpty: { ...typography.body, color: colors.textMuted, paddingVertical: 12 },
  sheetClose: { marginTop: 6 },

  skelLine: { justifyContent: 'center' },
});
