// 관제사 화면 (로그인, 넓은 화면) — 배달대행사 관제. 실제 소속 라이더의 보호 상태·위치·사고·주문.
// 대행사를 등록하면 라이더 가입 코드가 생긴다. 라이더가 그 코드로 소속돼야(= 보호 중 위치·사고를 이 관제에 보이는 데 동의) 여기에 보인다.
// 위치는 라이더가 보호 중일 때만 보이고, 볼 때마다 서버가 위치 이용 기록을 남긴다(라이더가 설정에서 확인).
import type { AgencyBoardDto, AgencyIncidentDto, AgencyOrderDto, AgencyRiderDto, DeliveryPlatform } from '@rider-guard/contract';
import Head from 'expo-router/head';
import { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useAgencyAction, useAgencyBoard, useMe, useSetAffiliation } from '@/api/hooks';
import { AccountBar } from '@/components/AccountBar';
import { ErrorText, Field, Notice } from '@/components/forms';
import { MapPill, RiderMap } from '@/components/RiderMap';
import { useToast } from '@/components/Toast';
import { Badge, Button, Txt, type BadgeTone } from '@/components/ui';
import { formatMobile } from '@/lib/format';
import { PLATFORM_SHORT, PLATFORMS, platformsText } from '@/lib/platforms';
import { colors, font, radius, typography } from '@/theme';

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }) : '—';

const INCIDENT: Record<AgencyIncidentDto['status'], { label: string; tone: BadgeTone }> = {
  countdown: { label: '라이더 확인 중', tone: 'red' },
  escalated: { label: '응답 없음 · 대응 필요', tone: 'redSolid' },
  cancelled: { label: '라이더 괜찮음', tone: 'neutral' },
  resolved: { label: '종료', tone: 'neutral' },
};
const ORDER: Record<AgencyOrderDto['status'], { label: string; tone: BadgeTone }> = {
  assigned: { label: '배달 중', tone: 'green' },
  held: { label: '보류 (사고)', tone: 'red' },
  reassigned: { label: '대체 배차됨', tone: 'dark' },
  delivered: { label: '완료', tone: 'neutral' },
};

export default function ControlScreen() {
  const { data: me } = useMe();
  const canUse = me?.role === 'dispatcher' || me?.role === 'admin';
  const board = useAgencyBoard(canUse);
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>BATON 관제</title>
      </Head>
      <AccountBar title="BATON 관제" sub="소속 라이더 보호 상태 · 사고 접수 · 주문 보류와 대체 배차" />
      {board.error && !board.data ? <Notice error={board.error} onRetry={() => void board.refetch()} /> : null}
      {!board.data ? (
        !board.error ? <Txt style={styles.meta}>불러오는 중</Txt> : null
      ) : board.data.agency ? (
        <Board b={board.data} />
      ) : (
        <AgencySetup />
      )}
      <Pressable
        accessibilityRole="link"
        onPress={() => (Platform.OS === 'web' ? window.open('/demo/control', '_blank') : undefined)}
        style={styles.demoLink}
      >
        <Txt style={styles.demoLinkText}>시연 데이터(ESP32 실측 파형)로 관제 흐름 보기 ↗</Txt>
      </Pressable>
    </ScrollView>
  );
}

// ── 대행사가 없을 때: 등록 또는 합류 ─────────────────────────────

function AgencySetup() {
  const action = useAgencyAction();
  const join = useSetAffiliation();
  const toast = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  return (
    <View style={styles.setupRow}>
      <View style={styles.setupCard}>
        <Txt style={styles.h2}>배달대행사 등록</Txt>
        <Txt style={styles.caption}>등록하면 라이더 가입 코드가 생겨요. 라이더가 앱에서 그 코드를 넣으면 이 화면에 들어와요.</Txt>
        <Field label="대행사 이름" value={name} onChangeText={setName} placeholder="예: 강남 바로배달" maxLength={40} />
        <ErrorText error={action.error} />
        <Button
          label="등록하기"
          disabled={!name.trim()}
          loading={action.isPending}
          onPress={() => action.mutate({ kind: 'create', name: name.trim() }, { onSuccess: () => toast.success('대행사를 등록했어요') })}
        />
      </View>
      <View style={styles.setupCard}>
        <Txt style={styles.h2}>다른 관제사의 대행사에 합류</Txt>
        <Txt style={styles.caption}>같은 대행사 관제사에게 가입 코드를 받아 넣어요.</Txt>
        <Field
          label="가입 코드"
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8))}
          placeholder="예: K7M2QX"
          autoCapitalize="characters"
        />
        <ErrorText error={join.error} />
        <Button
          label="합류하기"
          variant="outline"
          disabled={code.length < 4}
          loading={join.isPending}
          onPress={() => join.mutate({ joinCode: code, platforms: [] }, { onSuccess: () => toast.success('대행사에 합류했어요') })}
        />
      </View>
    </View>
  );
}

// ── 관제 화면 ──────────────────────────────────────────────────

function Board({ b }: { b: AgencyBoardDto }) {
  const { width } = useWindowDimensions();
  const wide = width >= 1100;
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const open = b.incidents.filter((i) => i.status === 'countdown' || i.status === 'escalated');
  // 선택이 없으면 사고 난 라이더 → 보호 중인 라이더 → 첫 라이더
  const selectedId = picked ?? open[0]?.riderId ?? b.riders.find((r) => r.protecting)?.id ?? b.riders[0]?.id ?? null;
  const selected = b.riders.find((r) => r.id === selectedId) ?? null;
  const agency = b.agency!;

  const copyCode = () => {
    if (Platform.OS === 'web' && navigator.clipboard) {
      void navigator.clipboard.writeText(agency.joinCode).then(() => toast.success('가입 코드를 복사했어요'));
    }
  };

  return (
    <>
      <View style={styles.strip}>
        <View style={styles.flex}>
          <Txt style={styles.agencyName}>{agency.name}</Txt>
          <Txt style={styles.caption}>라이더 앱 → 소속 배달대행사 → 가입 코드에 넣어 달라고 알려 주세요</Txt>
        </View>
        <Pressable onPress={copyCode} accessibilityRole="button" accessibilityLabel={`라이더 가입 코드 ${agency.joinCode}, 복사`} style={styles.codeBox}>
          <Txt style={styles.codeLabel}>라이더 가입 코드</Txt>
          <Txt style={styles.code}>{agency.joinCode}</Txt>
        </Pressable>
        <Stat n={b.riders.length} label="소속" />
        <Stat n={b.riders.filter((r) => r.protecting).length} label="보호 중" />
        <Stat n={b.orders.filter((o) => o.status === 'assigned').length} label="배달 중" />
        <Stat n={open.length} label="사고" red={open.length > 0} />
      </View>

      {open.map((i) => (
        <IncidentCard key={i.id} i={i} b={b} />
      ))}

      <View style={[styles.cols, !wide && styles.colsStack]}>
        <View style={[styles.panel, wide ? styles.ridersCol : null]}>
          <Txt style={styles.panelTitle}>{`소속 라이더 ${b.riders.length}명`}</Txt>
          {b.riders.length === 0 ? <Txt style={styles.meta}>아직 소속 라이더가 없어요. 위 가입 코드를 라이더에게 알려 주세요.</Txt> : null}
          {b.riders.map((r) => (
            <RiderRow key={r.id} r={r} b={b} selected={r.id === selectedId} onPress={() => setPicked(r.id)} />
          ))}
        </View>
        <View style={[styles.panel, styles.flex]}>
          {selected ? <RiderDetail r={selected} b={b} /> : <Txt style={styles.meta}>라이더를 고르면 위치와 주문이 보여요</Txt>}
        </View>
      </View>

      <Orders b={b} />
      <History b={b} />
    </>
  );
}

function Stat({ n, label, red }: { n: number; label: string; red?: boolean }) {
  return (
    <View style={styles.stat}>
      <Txt style={[styles.statN, red && { color: colors.red }]}>{String(n)}</Txt>
      <Txt style={styles.meta}>{label}</Txt>
    </View>
  );
}

function IncidentCard({ i, b }: { i: AgencyIncidentDto; b: AgencyBoardDto }) {
  const action = useAgencyAction();
  const st = INCIDENT[i.status];
  const held = b.orders.filter((o) => o.incidentId === i.id && o.status === 'held');
  return (
    <View style={styles.incident} accessibilityRole="alert">
      <View style={styles.incidentHead}>
        <Badge tone={st.tone}>{st.label}</Badge>
        <Txt style={styles.incidentTitle}>{`${i.riderName} · ${time(i.detectedAt)} 충격 감지`}</Txt>
        {i.ack ? <Txt style={styles.meta}>{`${i.ack.by} 접수 · ${time(i.ack.at)}`}</Txt> : null}
      </View>
      <Txt style={styles.caption}>
        {i.status === 'countdown'
          ? '라이더 앱에서 괜찮은지 묻는 중이에요. 응답이 없으면 비상연락·119 신고가 시작돼요.'
          : i.escalationReason === 'rider_requested'
            ? '라이더가 도움을 요청했어요. 비상연락·119 신고가 진행 중이에요.'
            : '라이더가 응답하지 않았어요. 비상연락·119 신고가 진행 중이에요.'}
        {held.length ? ` 들고 있던 주문 ${held.length}건을 보류했어요 — 아래 주문에서 대체 배차해 주세요.` : ''}
        {i.location ? ` 사고 위치 ${i.location.lat.toFixed(5)}, ${i.location.lng.toFixed(5)}` : ''}
      </Txt>
      <View style={styles.actions}>
        {!i.ack ? <Button label="접수하고 담당" size="sm" variant="red" loading={action.isPending && action.variables?.kind === 'ack'} onPress={() => action.mutate({ kind: 'ack', incidentId: i.id })} style={styles.btn} /> : null}
        {i.riderPhone ? <Button label={`라이더에게 전화 ${formatMobile(i.riderPhone)}`} size="sm" variant="outline" onPress={() => void Linking.openURL(`tel:${i.riderPhone}`)} style={styles.btn} /> : null}
        <Button
          label="대응 완료"
          size="sm"
          variant="dark"
          disabled={i.status !== 'escalated'}
          loading={action.isPending && action.variables?.kind === 'resolve'}
          onPress={() => action.mutate({ kind: 'resolve', incidentId: i.id })}
          style={styles.btn}
        />
      </View>
      <ErrorText error={action.error} />
    </View>
  );
}

function riderState(r: AgencyRiderDto): { label: string; tone: BadgeTone } {
  if (r.openIncidentId) return { label: '사고', tone: 'redSolid' };
  if (!r.protecting) return { label: '보호 꺼짐', tone: 'neutral' };
  return r.sensorOnline ? { label: '보호 중', tone: 'green' } : { label: '보호 중 · 센서 대기', tone: 'neutral' };
}

function RiderRow({ r, b, selected, onPress }: { r: AgencyRiderDto; b: AgencyBoardDto; selected: boolean; onPress: () => void }) {
  const st = riderState(r);
  const orders = b.orders.filter((o) => o.riderId === r.id && (o.status === 'assigned' || o.status === 'held')).length;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} style={[styles.riderRow, selected && styles.riderRowOn]}>
      <View style={styles.flex}>
        <Txt style={styles.riderName}>{r.name}</Txt>
        <Txt style={styles.meta} numberOfLines={1}>{`${platformsText(r.platforms)} · 진행 주문 ${orders}건`}</Txt>
      </View>
      <Badge tone={st.tone} size="sm">{st.label}</Badge>
    </Pressable>
  );
}

function RiderDetail({ r, b }: { r: AgencyRiderDto; b: AgencyBoardDto }) {
  const incident = b.incidents.find((i) => i.id === r.openIncidentId);
  const loc = incident?.location ?? r.location;
  return (
    <View style={styles.detail}>
      <View style={styles.detailHead}>
        <Txt style={styles.panelTitle}>{r.name}</Txt>
        {r.phone ? <Txt style={styles.meta}>{formatMobile(r.phone)}</Txt> : null}
      </View>
      <RiderMap
        location={loc ? { lat: loc.lat, lng: loc.lng, accuracy: 20 } : null}
        tone={incident ? 'red' : 'dark'}
        dim={!loc}
        label={incident ? `${time(incident.detectedAt)} 사고 위치` : loc ? r.name : null}
        height={320}
        radius={14}
        topLeft={<MapPill label={loc ? (r.location ? `위치 ${time(r.location.recordedAt)}` : '사고 위치') : '보호 중이 아니라 위치가 보이지 않아요'} />}
      />
    </View>
  );
}

function Orders({ b }: { b: AgencyBoardDto }) {
  const action = useAgencyAction();
  const toast = useToast();
  const [riderId, setRiderId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<DeliveryPlatform>('baemin');
  const [store, setStore] = useState('');
  const [dest, setDest] = useState('');
  const target = riderId ?? b.riders[0]?.id ?? null;
  const assign = () => {
    if (!target || !store.trim() || !dest.trim()) return;
    action.mutate(
      { kind: 'assign', body: { riderId: target, platform, storeName: store.trim(), destination: dest.trim() } },
      {
        onSuccess: () => {
          setStore('');
          setDest('');
          toast.success('주문을 배정했어요');
        },
      },
    );
  };
  const live = b.orders.filter((o) => o.status === 'assigned' || o.status === 'held');
  const done = b.orders.filter((o) => o.status !== 'assigned' && o.status !== 'held').slice(0, 10);
  return (
    <View style={styles.panel}>
      <Txt style={styles.panelTitle}>주문</Txt>
      {b.riders.length ? (
        <View style={styles.assign}>
          <Txt style={styles.label}>라이더</Txt>
          <Chips items={b.riders.map((r) => ({ key: r.id, label: r.name }))} value={target} onChange={setRiderId} />
          <Txt style={styles.label}>플랫폼</Txt>
          <Chips items={PLATFORMS.map((p) => ({ key: p, label: PLATFORM_SHORT[p] }))} value={platform} onChange={(p) => setPlatform(p as DeliveryPlatform)} />
          <View style={styles.assignRow}>
            <View style={styles.flex}>
              <Field label="가게" value={store} onChangeText={setStore} placeholder="역삼 김밥천국" maxLength={40} />
            </View>
            <View style={styles.flex}>
              <Field label="배달지" value={dest} onChangeText={setDest} placeholder="테헤란로 152 (12층)" maxLength={80} onSubmitEditing={assign} />
            </View>
            <Button label="배정" size="sm" disabled={!target || !store.trim() || !dest.trim()} loading={action.isPending && action.variables?.kind === 'assign'} onPress={assign} style={styles.assignBtn} />
          </View>
          <ErrorText error={action.error} />
        </View>
      ) : null}

      <View style={[styles.tr, styles.th]}>
        {['라이더', '플랫폼', '가게 → 배달지', '상태', ''].map((h, k) => (
          <Txt key={k} style={[styles.thText, k === 2 ? styles.cellWide : styles.cell]}>{h}</Txt>
        ))}
      </View>
      {live.length === 0 && done.length === 0 ? <Txt style={styles.meta}>진행 중인 주문이 없어요</Txt> : null}
      {[...live, ...done].map((o) => (
        <OrderRow key={o.id} o={o} b={b} />
      ))}
    </View>
  );
}

function OrderRow({ o, b }: { o: AgencyOrderDto; b: AgencyBoardDto }) {
  const action = useAgencyAction();
  const st = ORDER[o.status];
  const others = b.riders.filter((r) => r.id !== o.riderId && !r.openIncidentId);
  return (
    <View style={styles.tr}>
      <Txt style={[styles.td, styles.cell]}>{o.riderName}</Txt>
      <Txt style={[styles.td, styles.cell]}>{o.platform ? PLATFORM_SHORT[o.platform] : '—'}</Txt>
      <Txt style={[styles.td, styles.cellWide]} numberOfLines={1}>{`${o.storeName} → ${o.destination}`}</Txt>
      <View style={[styles.cell, styles.badgeCell]}>
        <Badge tone={st.tone} size="sm">{st.label}</Badge>
      </View>
      <View style={[styles.cell, styles.rowActions]}>
        {o.status === 'assigned' ? <Button label="배달 완료" size="sm" variant="soft" onPress={() => action.mutate({ kind: 'delivered', orderId: o.id })} style={styles.btn} /> : null}
        {o.status === 'held'
          ? others.length
            ? others.map((r) => <Button key={r.id} label={`→ ${r.name}`} size="sm" variant="dark" onPress={() => action.mutate({ kind: 'reassign', orderId: o.id, riderId: r.id })} style={styles.btn} />)
            : <Txt style={styles.meta}>넘길 라이더가 없어요</Txt>
          : null}
        {action.error ? <Txt style={styles.err}>{errorMessage(action.error)}</Txt> : null}
      </View>
    </View>
  );
}

function History({ b }: { b: AgencyBoardDto }) {
  const closed = b.incidents.filter((i) => i.status === 'cancelled' || i.status === 'resolved');
  if (!closed.length) return null;
  return (
    <View style={styles.panel}>
      <Txt style={styles.panelTitle}>{`지난 사고 (최근 하루) ${closed.length}건`}</Txt>
      {closed.map((i) => (
        <View key={i.id} style={styles.tr}>
          <Txt style={[styles.td, styles.cell]}>{time(i.detectedAt)}</Txt>
          <Txt style={[styles.td, styles.cell]}>{i.riderName}</Txt>
          <View style={[styles.cell, styles.badgeCell]}>
            <Badge tone={INCIDENT[i.status].tone} size="sm">{INCIDENT[i.status].label}</Badge>
          </View>
          <Txt style={[styles.td, styles.cellWide]}>{i.ack ? `${i.ack.by} 접수` : '관제 접수 없음'}</Txt>
        </View>
      ))}
    </View>
  );
}

function Chips({ items, value, onChange }: { items: { key: string; label: string }[]; value: string | null; onChange: (k: string) => void }) {
  return (
    <View style={styles.chips}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable key={it.key} onPress={() => onChange(it.key)} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
            <Txt style={[styles.chipText, on && styles.chipTextOn]}>{it.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 14, maxWidth: 1600, width: '100%', alignSelf: 'center' },
  flex: { flex: 1, minWidth: 0 },
  meta: { ...typography.meta },
  caption: { ...typography.caption },
  h2: { ...font.sans(800), fontSize: 18, color: colors.text },
  label: { ...font.sans(600), fontSize: 12.5, color: colors.textMuted },
  err: { ...font.sans(500), fontSize: 12, color: colors.error },

  setupRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  setupCard: { flexGrow: 1, flexBasis: 360, backgroundColor: colors.surface, borderRadius: radius.card, padding: 20, gap: 12 },

  strip: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, backgroundColor: colors.surface, borderRadius: radius.card, padding: 16 },
  agencyName: { ...font.sans(800), fontSize: 20, color: colors.text },
  codeBox: { backgroundColor: colors.asphalt, borderRadius: radius.lg, paddingVertical: 8, paddingHorizontal: 14, alignItems: 'center' },
  codeLabel: { ...font.sans(600), fontSize: 11, color: colors.textOnDark, opacity: 0.7 },
  code: { ...font.mono(700), fontSize: 22, letterSpacing: 4, color: colors.textOnDark },
  stat: { minWidth: 76, alignItems: 'center' },
  statN: { ...font.mono(700), fontSize: 24, color: colors.text },

  incident: { backgroundColor: colors.redSoft, borderRadius: radius.card, padding: 16, gap: 8, borderWidth: 1.5, borderColor: colors.red },
  incidentHead: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  incidentTitle: { ...font.sans(800), fontSize: 17, color: colors.text },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  btn: { paddingHorizontal: 14 },

  cols: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  colsStack: { flexDirection: 'column', alignItems: 'stretch' },
  ridersCol: { width: 380 },
  panel: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 4 },
  panelTitle: { ...font.sans(700), fontSize: 15, color: colors.text, marginBottom: 6 },
  riderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.lg, borderWidth: 1.5, borderColor: 'transparent' },
  riderRowOn: { borderColor: colors.asphalt, backgroundColor: colors.bg },
  riderName: { ...font.sans(700), fontSize: 15, color: colors.text },
  detail: { gap: 10 },
  detailHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },

  assign: { gap: 8, paddingBottom: 12, marginBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.divider },
  assignRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' },
  assignBtn: { paddingHorizontal: 22, marginBottom: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, height: 34, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1.5, borderColor: colors.border },
  chipOn: { backgroundColor: colors.asphalt, borderColor: colors.asphalt },
  chipText: { ...font.sans(600), fontSize: 13.5, color: colors.text },
  chipTextOn: { color: colors.textOnDark },

  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.divider },
  th: { borderTopWidth: 0 },
  thText: { ...font.sans(600), fontSize: 12, color: colors.textFaint },
  td: { ...font.sans(500), fontSize: 13.5, color: colors.text },
  cell: { flex: 1, minWidth: 0 },
  cellWide: { flex: 2.2, minWidth: 0 },
  badgeCell: { alignItems: 'flex-start' },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flex: 1.6 },

  demoLink: { alignSelf: 'flex-start', paddingVertical: 6 },
  demoLinkText: { ...font.sans(600), fontSize: 13, color: colors.textMuted, textDecorationLine: 'underline' },
});
