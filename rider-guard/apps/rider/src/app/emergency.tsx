// 디자인: spec-v3 09 '비상연락처 긴급 알림 웹' — 1순위 연락처가 받는 긴급 알림 페이지를 앱 안에서 그대로 보여 주는 미리보기. ?id=<사고 id>
// 실제 수신자 페이지는 서버의 /s/:token (사건·수신자 범위 권한, 라이더 로그인 없음)이다. 이 화면은 라이더 앱 안의 모의 화면이라
// 버튼 동작(확인·연락 안 됨·119 신고)은 서버에 보내지 않고 누구에게도 연락하지 않는다. 전화·지도 열기만 실제로 연다.
// 사고: ?id= → 없으면 가장 최근 사고 → 그것도 없으면 시뮬레이션 값. 닫기 버튼은 없다(브라우저·하드웨어 뒤로, iOS 는 쓸어내리기 — _layout).
import type { IncidentDetailDto, IncidentStep } from '@rider-guard/contract';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { isOpenStatus, useIncident, useIncidents, useMe } from '@/api/hooks';
import { ArrowUpRightIcon, CheckIcon, LogoIcon, PhoneIcon, WarningTriangleIcon } from '@/components/Icons';
import { RiderMap } from '@/components/RiderMap';
import { useToast } from '@/components/Toast';
import { Button, Card, FadeIn, FadeSwap, IconCircle, PressableScale, ProgressBar, Screen, SimBadge, Skeleton, Txt } from '@/components/ui';
import { useRiderPosition } from '@/features/location';
import { escalationCountdown, riderDisplayName, SELF_CHECK_S, simAddress, useNow } from '@/features/sim';
import { timeHM } from '@/lib/format';
import { colors, font, motion, radius, typography } from '@/theme';

type ContactsStep = Extract<IncidentStep, { key: 'contacts' }>;
const contactsStep = (incident: IncidentDetailDto) => incident.steps.find((s): s is ContactsStep => s.key === 'contacts');

/** 사고가 없거나 끝난 사고일 때 — 1순위에게 알린 지 19초 지난 것처럼 */
const SIM_ELAPSED_S = 19;
/** 확인 요청을 보내는 척 기다리는 시간 */
const SIM_SEND_MS = 600;

/** 지도 앱 주소 — 안드로이드는 지도 앱 선택, iOS 는 Apple 지도, 웹은 카카오맵 */
function mapUrl(lat: number, lng: number, label: string) {
  const q = encodeURIComponent(label);
  if (Platform.OS === 'android') return `geo:${lat},${lng}?q=${lat},${lng}(${q})`;
  if (Platform.OS === 'ios') return `https://maps.apple.com/?ll=${lat},${lng}&q=${q}`;
  return `https://map.kakao.com/link/map/${q},${lat},${lng}`;
}

export default function EmergencyScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const me = useMe();
  const list = useIncidents();
  const incidentId = id || list.data?.items[0]?.id;
  const incident = useIncident(incidentId);
  const pos = useRiderPosition();
  const toast = useToast();

  const [openedAt] = useState(() => Date.now());
  const [ackAt, setAckAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const loading = me.isLoading || (id ? incident.isLoading : list.isLoading || (!!incidentId && incident.isLoading));

  // ── 값 (없으면 시뮬레이션) ──
  const inc = incident.data;
  const live = !!inc && isOpenStatus(inc.status);
  const simStart = openedAt - SIM_ELAPSED_S * 1000;
  const detectedAt = inc?.detectedAt ?? simStart - SELF_CHECK_S * 1000;
  const step = inc ? contactsStep(inc) : undefined;
  // 진행 중인 사고는 1순위에게 알린 실제 시각부터(대응 상태 화면과 같은 기준), 아니면 지금 받은 것처럼
  const stepStart = live ? (step?.at ?? inc.escalatedAt ?? inc.detectedAt) : simStart;
  const serverAck = step?.detail.acknowledgedBy ?? null;
  const acked = ackAt != null || !!serverAck;

  // 진행 중인 사고는 서버 시각 기준 — 기기 시계 오차를 첫 응답으로 한 번만 정한다(대응 상태 화면과 같은 남은 시간)
  const [skew, setSkew] = useState<number | null>(null);
  if (inc && skew === null) setSkew(Date.parse(inc.serverTime) - incident.dataUpdatedAt);
  const now = useNow(1000, !acked && !skipped) + (live ? (skew ?? 0) : 0);
  const cd = escalationCountdown(stepStart, now, { steps: 1 });
  const notifiedNext = skipped || cd.done;

  const rider = riderDisplayName(me.data?.rider.name);
  const phone = me.data?.rider.phone ?? null;
  const location = inc?.location ?? pos;
  const locationAt = inc?.location?.recordedAt ?? detectedAt;
  const address = simAddress(inc?.location);
  const helpRequested = inc?.riderResponse === 'help';

  const call = useCallback(() => {
    if (!phone) {
      toast.info('등록된 휴대폰 번호가 없어요');
      return;
    }
    Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => toast.error('전화를 걸지 못했어요'));
  }, [phone, toast]);

  const openMap = useCallback(() => {
    Linking.openURL(mapUrl(location.lat, location.lng, `${rider}님 마지막 위치`)).catch(() => toast.error('지도 앱을 열지 못했어요'));
  }, [location.lat, location.lng, rider, toast]);

  const acknowledge = () => {
    setSending(true);
    timer.current = setTimeout(() => {
      setSending(false);
      setAckAt(Date.now());
      toast.info('미리보기라 실제 확인 응답은 보내지 않았어요');
    }, SIM_SEND_MS);
  };

  const unreachable = () => {
    if (acked || notifiedNext) {
      toast.info('2순위 연락처에게도 이미 알렸어요');
      return;
    }
    setSkipped(true);
    toast.info('미리보기라 2순위 연락처에게 실제로 알리지 않았어요');
  };

  if (loading) {
    return (
      <Screen tone="white" side={20} top={56} bottom={28} gap={0}>
        <Brand />
        <Warning />
        <EmergencySkeleton />
      </Screen>
    );
  }

  const seq = (i: number) => motion.stagger * i;

  return (
    <Screen tone="white" side={20} top={56} bottom={28} gap={0} enter="none">
      <FadeIn>
        <Brand />
        <SimBadge label="미리보기 · 모의 화면 · 실제 전송 없음" style={styles.mock} />
      </FadeIn>
      <FadeIn delay={seq(1)}>
        <Warning />
      </FadeIn>

      <FadeIn delay={seq(2)}>
        {/* 발생한 사실만 — 도움 요청이면 그 사실을, 무응답이면 '응답을 확인하지 못했다'고. 사고 확정처럼 말하지 않는다 */}
        <Txt accessibilityRole="header" style={styles.title}>
          {helpRequested ? `${rider}님이\n도움을 요청했어요` : `${rider}님에게\n강한 충격이 감지됐어요`}
        </Txt>
        <Txt style={styles.lead}>
          <Txt style={styles.leadTime}>{timeHM(detectedAt)}</Txt>{' '}
          {helpRequested ? '충격 감지 후 본인이 도움이 필요하다고 응답했어요' : '충격 감지 후 본인 응답을 확인하지 못했어요'}
        </Txt>
      </FadeIn>

      <FadeIn delay={seq(3)}>
        <Card tone="outline" style={styles.mapCard}>
          <RiderMap
            tone="red"
            label={`${timeHM(locationAt)} 마지막 위치`}
            location={location}
            height={MAP_H}
            radius={0}
            accessibilityLabel={`지도, ${timeHM(locationAt)} 마지막 위치, ${address}`}
          />
          <View style={styles.place}>
            <View style={styles.placeMain}>
              <Txt numberOfLines={2} style={styles.address}>
                {address}
              </Txt>
              <Txt style={styles.placeSub}>{`${timeHM(locationAt)} 기준 마지막 위치`}</Txt>
            </View>
            <PressableScale
              accessibilityRole="link"
              accessibilityLabel="지도 앱에서 열기"
              onPress={openMap}
              scaleTo={0.96}
              style={styles.mapLink}
              pressedStyle={styles.mapLinkPressed}
            >
              <Txt style={styles.mapLinkText}>지도 앱에서 열기</Txt>
              <ArrowUpRightIcon size={14} strokeWidth={2.4} color={colors.text} />
            </PressableScale>
          </View>
        </Card>
      </FadeIn>

      <FadeIn delay={seq(4)}>
        <FadeSwap swapKey={acked ? 'ack' : 'countdown'}>
          {acked ? (
            <Card style={styles.ackBox} accessibilityLabel="확인 완료">
              <IconCircle size={36} color={colors.green}>
                <CheckIcon size={20} strokeWidth={2.6} color={colors.textOnDark} />
              </IconCircle>
              <View style={styles.ackMain}>
                <Txt style={styles.ackTitle}>{serverAck ? `${serverAck}님이 확인했어요` : `${timeHM(ackAt ?? now)} 확인했어요`}</Txt>
                <Txt style={styles.ackBody}>2순위 연락처에게는 더 알리지 않아요.</Txt>
              </View>
            </Card>
          ) : (
            <Card tone="red" style={styles.countdown}>
              <View style={styles.countdownRow} accessible>
                <Txt style={styles.countdownTime}>{skipped ? '00:00' : cd.textPadded}</Txt>
                <Txt style={styles.countdownText}>
                  {notifiedNext ? '2순위 연락처에게도 알렸어요.' : '안에 확인하지 않으면 2순위 연락처에게도\n자동으로 알려요.'}
                </Txt>
              </View>
              <ProgressBar
                value={skipped ? 0 : cd.progress}
                height={4}
                color={colors.red}
                trackColor={colors.redTrack}
                accessibilityLabel="2순위 연락처에게 알리기까지 남은 시간"
                style={styles.countdownBar}
              />
            </Card>
          )}
        </FadeSwap>
      </FadeIn>

      <FadeIn delay={seq(5)} style={styles.actions}>
        <Button
          label={`${rider}님에게 전화`}
          variant="white"
          icon={<PhoneIcon size={19} color={colors.text} />}
          accessibilityRole="link"
          onPress={call}
        />
        <Button
          label={acked ? '대응을 맡았어요' : '확인했어요, 제가 대응할게요'}
          variant="red"
          icon={acked ? <CheckIcon size={18} strokeWidth={2.4} color={colors.disabledText} /> : undefined}
          loading={sending}
          disabled={acked}
          onPress={acknowledge}
        />
        <View style={styles.pair}>
          <Button
            label="연락이 안 돼요"
            variant="white"
            size="md"
            height={PAIR_H}
            rounded={radius.button}
            fontSize={15}
            style={styles.pairButton}
            textStyle={styles.pairLabel}
            onPress={unreachable}
          />
          <Button
            label="119에 신고했어요"
            variant="white"
            size="md"
            height={PAIR_H}
            rounded={radius.button}
            fontSize={15}
            style={styles.pairButton}
            textStyle={styles.pairLabel}
            // 실제 수신자 페이지에서도 이 버튼은 '수신자가 직접 신고했다'는 응답만 기록한다. 앱이 119에 신고하지 않는다
            onPress={() => toast.info('미리보기예요. 실제 페이지에서는 직접 신고했다는 응답만 기록돼요')}
          />
        </View>
      </FadeIn>
    </Screen>
  );
}

/** 로고 타일 + 'Rider Guard 긴급 알림' */
function Brand() {
  return (
    <View style={styles.brand} accessible accessibilityRole="header" accessibilityLabel="Rider Guard 긴급 알림">
      <LogoIcon size={22} check={false} />
      <Txt style={styles.brandText}>Rider Guard 긴급 알림</Txt>
    </View>
  );
}

/** 빨간 경고 삼각형 */
function Warning() {
  return (
    <View style={styles.warning} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WarningTriangleIcon size={62} color={colors.red} />
    </View>
  );
}

function EmergencySkeleton() {
  return (
    <View style={styles.skeleton}>
      <Skeleton width="62%" height={30} style={styles.center} />
      <Skeleton width="52%" height={30} style={styles.center} />
      <Skeleton width="80%" height={16} style={[styles.center, styles.skeletonLead]} />
      <Skeleton width="100%" height={MAP_H + 66} radius={radius.card} style={styles.skeletonCard} />
      <Skeleton width="100%" height={84} radius={radius.card} style={styles.skeletonBox} />
    </View>
  );
}

const MAP_H = 150;
const PAIR_H = 50;

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  mock: { alignSelf: 'center', marginTop: 8 },
  brandText: { ...font.sans(700), fontSize: 15, lineHeight: 22, letterSpacing: -0.45, color: colors.text },
  warning: { alignItems: 'center', marginTop: 19 },
  // 이 화면 제목은 다른 화면(28)보다 한 단계 크다 (디자인 글리프 폭 198.5 · 높이 26.5)
  title: { ...typography.title, fontSize: 29, lineHeight: 37.5, textAlign: 'center', marginTop: 7 },
  lead: { ...font.sans(400), fontSize: 15, lineHeight: 22, color: colors.textMuted, textAlign: 'center', marginTop: 7.5 },
  leadTime: { ...font.mono(700), color: colors.text },

  mapCard: { marginTop: 19.5, overflow: 'hidden', borderColor: colors.curb },
  place: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13.5, paddingLeft: 16.5, paddingRight: 14 },
  placeMain: { flex: 1 },
  address: { ...font.sans(700), fontSize: 16, lineHeight: 19, letterSpacing: -0.2, color: colors.text },
  placeSub: { ...font.sans(400), fontSize: 12, lineHeight: 15, letterSpacing: -0.25, color: colors.textFaint, marginTop: 2, fontVariant: ['tabular-nums'] },
  mapLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 33,
    paddingLeft: 13,
    paddingRight: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
  },
  mapLinkPressed: { backgroundColor: colors.curb },
  mapLinkText: { ...font.sans(700), fontSize: 13, lineHeight: 18, letterSpacing: -0.4, color: colors.text },

  // 상자 87.5 · 막대는 상자 아래에서 14.5 위 (v3·9 측정)
  countdown: { marginTop: 13, paddingTop: 12.5, paddingBottom: 14.5, paddingHorizontal: 16 },
  // 알린 뒤 문구가 한 줄이 돼도 상자 높이가 흔들리지 않게 두 줄 높이를 잡아 둔다
  countdownRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, minHeight: 40 },
  countdownTime: { ...font.mono(800), fontSize: 22, lineHeight: 24, letterSpacing: -0.2, color: colors.redInk },
  countdownText: { ...font.sans(400), flex: 1, fontSize: 14, lineHeight: 20, letterSpacing: -0.15, color: colors.redInk, marginTop: 3 },
  countdownBar: { marginTop: 13.5 },
  ackBox: {
    marginTop: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 84,
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: colors.greenSoft,
  },
  ackMain: { flex: 1, gap: 2 },
  ackTitle: { ...font.sans(700), fontSize: 16, lineHeight: 22, letterSpacing: -0.2, color: colors.text },
  ackBody: { ...font.sans(400), fontSize: 14, lineHeight: 20, color: colors.textMuted },

  actions: { marginTop: 28, gap: 10 },
  pair: { flexDirection: 'row', gap: 10 },
  pairButton: { flex: 1, paddingHorizontal: 8 },
  pairLabel: { letterSpacing: -0.3 },

  skeleton: { marginTop: 14, gap: 8 },
  center: { alignSelf: 'center' },
  skeletonLead: { marginTop: 6 },
  skeletonCard: { marginTop: 20 },
  skeletonBox: { marginTop: 6 },
});
