// 시연: 보호가 켜진 라이더 화면. '지금 감시가 이루어지고 있다'는 근거(보호 시간·센서 수신·위치·비상연락 준비)를 보여 주고,
// 사고 후보가 서면 같은 자리에서 확인 요청으로, 관제가 움직이면 그 결과로 바뀐다.
import { StyleSheet, View } from 'react-native';

import { AlertIcon, CheckIcon, HelmetIcon, MapPinIcon, ShieldCheckIcon, UsersIcon } from '@/components/Icons';
import { MapPill, RiderMap } from '@/components/RiderMap';
import { Badge, Button, Txt } from '@/components/ui';
import {
  activeOrders,
  clockAt,
  CONTROLLER,
  DEMO_STALE_S,
  FIRST_CONTACT,
  MAIN_RIDER,
  RESPONSE_WAIT_S,
  sensorStale,
  waitLeft,
  type DemoState,
  type DemoAction,
} from '@/features/demo/engine';
import { dispatch } from '@/features/demo/store';
import { dispatchPresentationAction, presentationMutationBlock } from '@/features/demo/display';
import { getPresentationConnection, usePresentationConnection } from '@/features/demo/presentation';
import { mmss } from '@/lib/format';
import { colors, font, radius, typography } from '@/theme';

const AMBER = '#9A5B00';
const AMBER_SOFT = '#FFF3DC';
const mutate = (action: DemoAction) => dispatchPresentationAction(getPresentationConnection(), action, dispatch);

export function RiderPhone({ s, height = 760, compact = false }: { s: DemoState; height?: number; compact?: boolean }) {
  const i = s.incident;
  const rider = s.riders.find((r) => r.id === MAIN_RIDER)!;
  const confirming = i?.status === 'confirming';
  return (
    <View style={[styles.frame, compact ? styles.frameCompact : { minHeight: height }]}>
      {!compact ? <View style={styles.notch} /> : null}
      <View style={[styles.screen, compact && styles.screenCompact, confirming && styles.screenAlert]}>
        <View style={[styles.statusBar, compact && styles.statusCompact]}>
          <Txt style={[styles.statusText, confirming && styles.onDark]}>{clockAt(s, s.t).slice(0, 5)}</Txt>
          <Txt style={[styles.statusText, confirming && styles.onDark]}>Rider Guard</Txt>
        </View>
        {confirming ? <Confirm s={s} compact={compact} /> : <Protect s={s} riderName={rider.name} compact={compact} />}
      </View>
    </View>
  );
}

function Confirm({ s, compact }: { s: DemoState; compact: boolean }) {
  const blocked = presentationMutationBlock(usePresentationConnection());
  const left = waitLeft(s) ?? 0;
  const i = s.incident!;
  return (
    <View style={[styles.confirm, compact && styles.confirmCompact]}>
      <View style={[styles.sos, compact && styles.sosCompact]}>
        <AlertIcon size={34} color={colors.textOnDark} />
      </View>
      <Txt style={[styles.confirmTitle, compact && styles.confirmTitleCompact]}>{'사고가 의심돼요.\n괜찮으신가요?'}</Txt>
      {!compact ? <Txt style={styles.confirmSub}>{`${clockAt(s, i.detectedT)} 강한 충격이 감지됐어요`}</Txt> : null}
      <View style={[styles.countWrap, compact && styles.countWrapCompact]}>
        <Txt style={[styles.count, compact && styles.countCompact]}>{Math.ceil(left)}</Txt>
        <Txt style={styles.countUnit}>{compact ? '초 후 자동 연락' : '초 뒤 관제와 비상연락처에 알려요'}</Txt>
      </View>
      <View style={styles.track}>
        <View style={[styles.trackFill, { width: `${(left / RESPONSE_WAIT_S) * 100}%` }]} />
      </View>
      <View style={[styles.confirmButtons, compact && styles.confirmButtonsCompact]}>
        <Button label="괜찮아요" variant="white" size={compact ? 'md' : 'xl'} disabled={!!blocked} onDark onPress={() => mutate({ type: 'respond', response: 'ok' })} />
        <Button label="도움이 필요해요" variant="red" size={compact ? 'md' : 'lg'} disabled={!!blocked} onDark onPress={() => mutate({ type: 'respond', response: 'help' })} />
      </View>
      {blocked ? <Txt accessibilityRole="alert" style={styles.confirmSub}>{blocked}</Txt> : null}
      {!compact ? <Txt style={styles.confirmNote}>{`응답 대기 ${RESPONSE_WAIT_S}초는 운영 설정값이에요. 센서 판정 시각과 별개예요.`}</Txt> : null}
    </View>
  );
}

function Row({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>{icon}</View>
      <Txt style={styles.rowLabel}>{label}</Txt>
      <Txt style={[styles.rowValue, tone === 'warn' && { color: AMBER }, tone === 'bad' && { color: colors.redInk }, tone === 'ok' && { color: colors.green }]}>
        {value}
      </Txt>
    </View>
  );
}

function Protect({ s, riderName, compact }: { s: DemoState; riderName: string; compact: boolean }) {
  const i = s.incident;
  const stale = sensorStale(s);
  const lost = s.sensorLost;
  const ago = Math.max(0, s.t - s.lastSensorT);
  const orders = activeOrders(s, MAIN_RIDER);
  const escalated = i && (i.status === 'escalated' || i.status === 'acknowledged');
  const pill = escalated ? { label: '사고 대응 중', dot: colors.red, halo: colors.redSoft } : stale ? { label: '센서 연결 확인 필요', dot: AMBER, halo: AMBER_SOFT } : { label: '보호 중', dot: colors.green, halo: colors.greenSoft };

  return (
    <View style={styles.body}>
      <View>
        {!compact ? <Txt style={styles.hello}>안녕하세요</Txt> : null}
        <Txt style={[styles.name, compact && styles.nameCompact]}>{`${riderName}님`}</Txt>
      </View>

      <View style={styles.card}>
        <RiderMap
          location={{ lat: 37.5006, lng: 127.0364, accuracy: 20 }}
          label={compact ? '시연 위치' : escalated ? `${clockAt(s, i!.detectedT).slice(0, 5)} 사고 위치` : '지금 여기'}
          tone={escalated ? 'red' : 'dark'}
          height={compact ? 100 : 150}
          radius={14}
          topLeft={!compact ? <MapPill label={pill.label} dot={pill.dot} halo={pill.halo} /> : undefined}
          topRight={!compact ? <MapPill label="시연 위치" /> : undefined}
        />
        <View style={styles.hero}>
          <ShieldCheckIcon size={20} color={escalated ? colors.red : stale ? AMBER : colors.green} />
          <Txt style={styles.heroTitle}>{escalated ? compact ? '관제 대응 중' : '관제와 비상연락처가 대응하고 있어요' : stale ? '센서 연결 확인' : '보호 켜짐'}</Txt>
          {!compact ? <Txt style={styles.heroTime}>{mmss(s.t)}</Txt> : null}
        </View>
        <View style={styles.rows}>
          <Row icon={<HelmetIcon size={16} color={colors.textFaint} />} label="헬멧 센서" value={lost ? '신호 없음' : compact ? '연결됨' : '연결됨 · 1kHz'} tone={lost ? (stale ? 'bad' : 'warn') : 'ok'} />
          <Row
            icon={<ShieldCheckIcon size={16} color={colors.textFaint} />}
            label="최근 센서 수신"
            value={lost ? `${Math.floor(ago)}초 전${stale || compact ? '' : ` · ${DEMO_STALE_S}초 지나면 확인 필요`}` : s.playing ? '방금' : '일시정지'}
            tone={stale ? 'bad' : lost ? 'warn' : undefined}
          />
          {!compact ? <Row icon={<MapPinIcon size={16} color={colors.textFaint} />} label="위치" value={`${clockAt(s, Math.max(0, s.t - (s.t % 5)))} 갱신 · 역삼동`} /> : null}
          {!compact ? <Row icon={<UsersIcon size={16} color={colors.textFaint} />} label="비상연락" value={i?.contactNotifiedT != null ? `${FIRST_CONTACT.split(' ')[0]}님에게 알림 (시연)` : '1순위 수락 · 준비됨'} tone={i?.contactNotifiedT != null ? 'bad' : 'ok'} /> : null}
        </View>
      </View>

      {i?.status === 'rider_ok' ? <Banner tone="ok" title="라이더 확인 · 보호 재개" sub={compact ? undefined : '감시를 이어가요. 실제 사고가 아니었다고 확정하지는 않아요.'} /> : null}
      {escalated ? (
        <View style={styles.card}>
          <Txt style={styles.section}>{compact ? i!.response === 'help' ? '도움 요청' : '미응답 · 자동 연락' : i!.response === 'help' ? '도움을 요청했어요' : `${RESPONSE_WAIT_S}초 동안 응답이 없어 알렸어요`}</Txt>
          <Step done={i!.status === 'acknowledged'} label={i!.status === 'acknowledged' ? '관제 접수 완료' : '관제 접수 대기'} sub={compact ? undefined : i!.ackT !== null ? `${CONTROLLER} · ${clockAt(s, i!.ackT)}` : '배달대행사 관제에 사건이 접수됐어요'} />
          <Step done label={compact ? '비상연락·위치 공유 기록' : '비상연락처에 위치를 공유했어요'} sub={compact ? undefined : `${FIRST_CONTACT} · 시연이라 실제 발송 없음`} />
          {i!.calls.length ? <Step done label="관제사 전화" sub={i!.calls.at(-1)!.result} /> : null}
          <Step
            done={s.orders.filter((o) => o.originalRiderId === MAIN_RIDER).every((o) => o.status !== 'held')}
            label={s.orders.some((o) => o.originalRiderId === MAIN_RIDER && o.status === 'held') ? '주문 보류' : '주문 인계 완료'}
            sub={compact ? undefined : s.orders
              .filter((o) => o.originalRiderId === MAIN_RIDER)
              .map((o) => `${o.id} ${o.status === 'held' ? '보류' : `→ ${s.riders.find((r) => r.id === o.riderId)?.name}`}`)
              .join(' · ')}
          />
        </View>
      ) : null}
      {i?.status === 'resolved' ? <Banner tone="ok" title="시연 대응 종결" sub={compact ? undefined : `${i.assignee ?? CONTROLLER} 처리 기록이에요. 실제 구조 완료를 뜻하지 않아요.`} /> : null}

      {!escalated && !compact ? (
        <View style={styles.card}>
          <Txt style={styles.section}>{`진행 주문 ${orders.length}건`}</Txt>
          {orders.length ? (
            orders.map((o) => (
              <Txt key={o.id} style={styles.order}>{`${o.id}  ${o.store} → ${o.customer}`}</Txt>
            ))
          ) : (
            <Txt style={styles.order}>배차 대기 중</Txt>
          )}
        </View>
      ) : null}
    </View>
  );
}

function Step({ done, label, sub }: { done: boolean; label: string; sub?: string }) {
  return (
    <View style={styles.step}>
      <View style={[styles.stepDot, done && styles.stepDotDone]}>{done ? <CheckIcon size={12} color={colors.textOnDark} /> : null}</View>
      <View style={styles.flex}>
        <Txt style={styles.stepLabel}>{label}</Txt>
        {sub ? <Txt style={styles.stepSub}>{sub}</Txt> : null}
      </View>
    </View>
  );
}

function Banner({ title, sub }: { tone: 'ok'; title: string; sub?: string }) {
  return (
    <View style={styles.banner}>
      <CheckIcon size={18} color={colors.green} />
      <View style={styles.flex}>
        <Txt style={styles.bannerTitle}>{title}</Txt>
        {sub ? <Txt style={styles.bannerSub}>{sub}</Txt> : null}
      </View>
    </View>
  );
}

export function SourceBadge({ label = '실측 파형 · 시연 데이터' }: { label?: string }) {
  return <Badge tone="neutral" size="sm">{label}</Badge>;
}

const styles = StyleSheet.create({
  frame: { width: '100%', maxWidth: 372, borderRadius: 44, backgroundColor: colors.asphalt, padding: 10, alignSelf: 'center' },
  frameCompact: { maxWidth: '100%', borderRadius: 22, padding: 5 },
  notch: { position: 'absolute', top: 16, alignSelf: 'center', width: 96, height: 24, borderRadius: 12, backgroundColor: colors.asphalt, zIndex: 2 },
  screen: { flex: 1, borderRadius: 34, backgroundColor: colors.bg },
  screenCompact: { borderRadius: 18 },
  screenAlert: { backgroundColor: colors.alertBg },
  statusBar: { height: 44, paddingHorizontal: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusCompact: { minHeight: 34, height: 'auto', paddingHorizontal: 14, paddingVertical: 8 },
  statusText: { ...font.sans(600), fontSize: 13, color: colors.text },
  onDark: { color: colors.textOnDark },
  body: { flex: 1, paddingHorizontal: 14, paddingBottom: 14, gap: 10 },
  hello: { ...typography.caption },
  name: { ...font.sans(800), fontSize: 22, lineHeight: 28, letterSpacing: -0.6, color: colors.text },
  nameCompact: { fontSize: 17, lineHeight: 23 },
  card: { backgroundColor: colors.surface, borderRadius: 18, padding: 8, gap: 6 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingTop: 6 },
  heroTitle: { ...font.sans(800), fontSize: 16.5, lineHeight: 22, letterSpacing: -0.4, color: colors.text, flex: 1 },
  heroTime: { ...font.mono(600), fontSize: 15, color: colors.text },
  rows: { paddingHorizontal: 6, paddingBottom: 4, gap: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowIcon: { width: 18, alignItems: 'center' },
  rowLabel: { ...typography.caption, width: 84 },
  rowValue: { ...font.sans(600), fontSize: 13, lineHeight: 18, color: colors.text, flex: 1, textAlign: 'right' },
  section: { ...font.sans(700), fontSize: 14, lineHeight: 20, color: colors.text, paddingHorizontal: 6, paddingTop: 4 },
  order: { ...typography.caption, paddingHorizontal: 6, paddingBottom: 2 },
  step: { flexDirection: 'row', gap: 8, paddingHorizontal: 6, paddingVertical: 3 },
  stepDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepDotDone: { backgroundColor: colors.green, borderColor: colors.green },
  stepLabel: { ...font.sans(700), fontSize: 13.5, lineHeight: 19, color: colors.text },
  stepSub: { ...typography.meta },
  flex: { flex: 1, minWidth: 0 },
  banner: { flexDirection: 'row', gap: 8, backgroundColor: colors.greenSoft, borderRadius: 14, padding: 12, alignItems: 'flex-start' },
  bannerTitle: { ...font.sans(700), fontSize: 14, lineHeight: 20, color: colors.text },
  bannerSub: { ...typography.meta, color: colors.textMuted },
  confirm: { flex: 1, paddingHorizontal: 22, paddingBottom: 22, alignItems: 'center' },
  confirmCompact: { paddingHorizontal: 14, paddingBottom: 16 },
  sos: { marginTop: 26, width: 84, height: 84, borderRadius: 42, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 48px rgba(229,50,45,0.6)' },
  sosCompact: { marginTop: 10, width: 52, height: 52, borderRadius: 26 },
  confirmTitle: { ...font.sans(800), fontSize: 27, lineHeight: 36, letterSpacing: -0.8, color: colors.textOnDark, textAlign: 'center', marginTop: 24 },
  confirmTitleCompact: { fontSize: 23, lineHeight: 31, marginTop: 12 },
  confirmSub: { ...font.sans(500), fontSize: 14, lineHeight: 20, color: colors.textOnDarkMuted, marginTop: 8 },
  countWrap: { alignItems: 'center', marginTop: 26 },
  countWrapCompact: { marginTop: 14 },
  count: { ...font.mono(700), fontSize: 64, lineHeight: 70, color: colors.textOnDark },
  countCompact: { fontSize: 46, lineHeight: 52 },
  countUnit: { ...font.sans(500), fontSize: 13, color: colors.textOnDarkMuted },
  track: { alignSelf: 'stretch', height: 5, borderRadius: radius.pill, backgroundColor: colors.navyTrack, marginTop: 14, overflow: 'hidden' },
  trackFill: { height: 5, backgroundColor: colors.red },
  confirmButtons: { alignSelf: 'stretch', gap: 10, marginTop: 'auto' },
  confirmButtonsCompact: { marginTop: 18, gap: 8 },
  confirmNote: { ...font.sans(500), fontSize: 11.5, lineHeight: 16, color: colors.textOnDarkFaint, textAlign: 'center', marginTop: 10 },
});
