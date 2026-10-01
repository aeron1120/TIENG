// 시연: 배달대행사 관제 화면 (넓은 데스크톱). 왼쪽 라이더 목록 · 가운데 지도 · 오른쪽 사건 · 아래 주문.
// 버튼은 시연 세계의 상태를 실제로 바꾼다 — 접수하면 라이더 화면에 '관제사가 확인했어요', 대체 배차하면 주문 담당이 바뀐다.
import type { SensorAnalysis } from '@rider-guard/contract';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { evidenceHeadline } from '@/components/IncidentEvidence';
import { MapPill, RiderMap } from '@/components/RiderMap';
import { Badge, Button, Txt, type BadgeTone } from '@/components/ui';
import {
  activeOrders,
  clockAt,
  CONTROLLER,
  FIRST_CONTACT,
  INCIDENT_STATUS_LABEL,
  MAIN_RIDER,
  replacementCandidates,
  RESPONSE_LABEL,
  RIDER_STATUS_LABEL,
  riderStatus,
  waitLeft,
  type DemoOrder,
  type DemoAction,
  type DemoState,
  type RiderStatus,
} from '@/features/demo/engine';
import { dispatch } from '@/features/demo/store';
import { dispatchPresentationAction, presentationMutationBlock, presentationStage } from '@/features/demo/display';
import { getPresentationConnection, openPresentationReport, usePresentationConnection } from '@/features/demo/presentation';
import { colors, font, radius, typography } from '@/theme';

const STATUS_TONE: Record<RiderStatus, BadgeTone> = { delivering: 'green', idle: 'neutral', off: 'muted', check: 'red', incident: 'redSolid' };
const ORDER_LABEL: Record<DemoOrder['status'], string> = { delivering: '배달 중', held: '보류', reassigned: '대체 배차', delivered: '완료' };
const ORDER_TONE: Record<DemoOrder['status'], BadgeTone> = { delivering: 'green', held: 'red', reassigned: 'dark', delivered: 'neutral' };
const METRIC_LABEL: Record<SensorAnalysis['evidence'][number]['key'], string> = { peak_g: '가속도', peak_gyro: '각속도', delta_v150: 'ΔV', bank_deg: '뱅크각' };
const UNIT: Record<string, string> = { g: 'g', 'deg/s': '°/s', 'm/s': 'm/s', deg: '°' };
const mutate = (action: DemoAction) => dispatchPresentationAction(getPresentationConnection(), action, dispatch);

export function openReport() {
  openPresentationReport();
}

export function ControlRoom({ s, analysis, mapHeight = 300, compact = false }: { s: DemoState; analysis: SensorAnalysis | null; mapHeight?: number; compact?: boolean }) {
  const blocked = presentationMutationBlock(usePresentationConnection());
  // 사건이 생기면 그 라이더로 — 그 사건 동안 관제사가 다른 라이더를 고르면 그쪽을 따른다
  const incidentId = s.incident?.id;
  const [picked, setPicked] = useState<{ id: string; during: string | undefined }>({ id: MAIN_RIDER, during: undefined });
  const [roomWidth, setRoomWidth] = useState(0);
  const selected = incidentId && picked.during !== incidentId ? MAIN_RIDER : picked.id;
  const setSelected = (id: string) => setPicked({ id, during: incidentId });
  const rider = s.riders.find((r) => r.id === selected) ?? s.riders[0]!;
  const counts = s.riders.reduce<Record<RiderStatus, number>>((acc, r) => ({ ...acc, [riderStatus(s, r)]: acc[riderStatus(s, r)] + 1 }), { delivering: 0, idle: 0, off: 0, check: 0, incident: 0 });
  const st = riderStatus(s, rider);
  const orders = s.orders.filter((o) => o.riderId === rider.id || o.originalRiderId === rider.id);

  if (compact) return (
    <View style={styles.room}>
      <View style={styles.top}>
        <Txt style={styles.brand}>BATON 관제</Txt>
        <Txt style={styles.clock}>{clockAt(s, s.t)}</Txt>
        <Badge tone="neutral" size="sm">{`주요 라이더 · ${s.riders.find((r) => r.id === MAIN_RIDER)?.name ?? '-'}`}</Badge>
      </View>
      <IncidentPanel s={s} analysis={analysis} compact />
      {blocked ? <Txt accessibilityRole="alert" style={styles.meta}>{blocked}</Txt> : null}
      <View style={styles.orders}>
        <Txt style={styles.colTitle}>주요 라이더의 주문 · 보류와 인계 결과</Txt>
        {s.orders.filter((o) => o.originalRiderId === MAIN_RIDER).map((o) => <CompactOrder key={o.id} s={s} o={o} />)}
      </View>
    </View>
  );

  return (
    <View style={styles.room} onLayout={(e) => setRoomWidth(e.nativeEvent.layout.width)}>
      <View style={styles.top}>
        <Txt style={styles.brand}>BATON 배달대행 관제</Txt>
        <Badge tone="neutral" size="sm">시연 데이터 · 실제 발송 없음</Badge>
        <View style={styles.flex} />
        <Count label="배달 중" n={counts.delivering} />
        <Count label="대기" n={counts.idle} />
        <Count label="확인 필요" n={counts.check} alert={counts.check > 0} />
        <Count label="사고 대응" n={counts.incident} alert={counts.incident > 0} />
        <Txt style={styles.clock}>{clockAt(s, s.t)}</Txt>
      </View>

      {blocked ? <Txt accessibilityRole="alert" style={styles.meta}>{blocked}</Txt> : null}
      <View style={[styles.main, roomWidth < 920 && styles.mainStack]}>
        <View style={[styles.left, roomWidth < 920 && styles.fullWidth]}>
          <Txt style={styles.colTitle}>{`소속 라이더 ${s.riders.length}명`}</Txt>
          {s.riders.map((r) => {
            const rs = riderStatus(s, r);
            return (
              <Pressable key={r.id} onPress={() => setSelected(r.id)} style={[styles.riderItem, r.id === selected && styles.riderSel, rs === 'incident' && styles.riderAlert]} accessibilityRole="button" accessibilityLabel={`${r.name}, ${RIDER_STATUS_LABEL[rs]}`}>
                <View style={styles.riderHead}>
                  <Txt style={styles.riderName}>{r.name}</Txt>
                  <Badge tone={STATUS_TONE[rs]} size="sm" dot={rs === 'delivering' || rs === 'incident'}>{RIDER_STATUS_LABEL[rs]}</Badge>
                </View>
                <Txt style={styles.riderSub}>{`${r.area} · 진행 주문 ${activeOrders(s, r.id).filter((o) => o.status !== 'held').length}건${r.id === MAIN_RIDER ? ' · 헬멧 센서' : ''}`}</Txt>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.center}>
          <RiderMap
            location={{ lat: rider.lat, lng: rider.lng, accuracy: 20 }}
            tone={st === 'incident' || st === 'check' ? 'red' : 'dark'}
            label={st === 'incident' && s.incident ? `${clockAt(s, s.incident.detectedT)} 사고 위치` : rider.name}
            height={mapHeight}
            radius={14}
            topLeft={<MapPill label={`${rider.name} · ${RIDER_STATUS_LABEL[st]}`} dot={st === 'incident' || st === 'check' ? colors.red : colors.green} halo={st === 'incident' || st === 'check' ? colors.redSoft : colors.greenSoft} />}
            topRight={<MapPill label={`위치 갱신 ${clockAt(s, Math.max(0, s.t - (s.t % 5)))}`} />}
          />
          <View style={styles.logBox}>
            <Txt style={styles.colTitle}>최근 이벤트</Txt>
            <ScrollView style={styles.logScroll}>
              {[...s.log].reverse().slice(0, 12).map((l, k) => (
                <View key={k} style={styles.logRow}>
                  <Txt style={styles.logTime}>{clockAt(s, l.t)}</Txt>
                  <Txt style={styles.logText}>{l.text}</Txt>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>

        <View style={[styles.right, roomWidth < 920 && styles.fullWidth]}>
          <IncidentPanel s={s} analysis={analysis} />
        </View>
      </View>

      <View style={styles.orders}>
        <Txt style={styles.colTitle}>{`${rider.name} 라이더 주문`}</Txt>
        {roomWidth >= 800 ? <View style={[styles.tr, styles.th]}>
          {['주문', '가게 → 고객', '담당', '상태', '보류 사유', '대체 배차', '안내 이력'].map((h, k) => (
            <Txt key={h} style={[styles.thText, { flex: COLS[k] }]}>{h}</Txt>
          ))}
        </View> : null}
        {orders.length === 0 ? <Txt style={styles.empty}>진행 중인 주문이 없어요</Txt> : null}
        {orders.map((o) => (
          roomWidth < 800 ? <CompactOrder key={o.id} s={s} o={o} /> : <OrderRow key={o.id} s={s} o={o} />
        ))}
      </View>
    </View>
  );
}

const COLS = [0.8, 2, 0.9, 0.9, 1.1, 2.2, 2.4];

function CompactOrder({ s, o }: { s: DemoState; o: DemoOrder }) {
  const blocked = presentationMutationBlock(usePresentationConnection());
  const owner = s.riders.find((r) => r.id === o.riderId)?.name ?? '-';
  const last = o.notices.at(-1);
  return <View style={styles.compactOrder}>
    <View style={styles.riderHead}><Txt style={styles.strongLine}>{o.id} · {owner}</Txt><Badge tone={ORDER_TONE[o.status]} size="sm">{ORDER_LABEL[o.status]}</Badge></View>
    <Txt style={styles.meta}>{o.store} → {o.customer}</Txt>
    {o.status === 'held' ? <View style={styles.chips}>{replacementCandidates(s).slice(0, 2).map((r) => <Button key={r.id} label={`${r.name}에게 인계`} size="sm" variant="outline" disabled={!!blocked} onPress={() => mutate({ type: 'reassign', orderId: o.id, riderId: r.id })} />)}</View> : null}
    {last ? <Txt style={styles.meta}>{`${last.to} 안내 · ${last.text} (시연)`}</Txt> : null}
  </View>;
}

function OrderRow({ s, o }: { s: DemoState; o: DemoOrder }) {
  const blocked = presentationMutationBlock(usePresentationConnection());
  const owner = s.riders.find((r) => r.id === o.riderId)?.name ?? '-';
  const from = s.riders.find((r) => r.id === o.originalRiderId)?.name ?? '-';
  const last = o.notices.at(-1);
  return (
    <View style={styles.tr}>
      <Txt style={[styles.td, styles.mono, { flex: COLS[0] }]}>{o.id}</Txt>
      <Txt style={[styles.td, { flex: COLS[1] }]} numberOfLines={2}>{`${o.store} → ${o.customer}`}</Txt>
      <Txt style={[styles.td, styles.strong, { flex: COLS[2] }]}>{o.riderId !== o.originalRiderId ? `${owner} (← ${from})` : owner}</Txt>
      <View style={{ flex: COLS[3] }}>
        <Badge tone={ORDER_TONE[o.status]} size="sm">{ORDER_LABEL[o.status]}</Badge>
      </View>
      <Txt style={[styles.td, { flex: COLS[4] }]}>{o.holdReason ?? '-'}</Txt>
      <View style={[styles.chips, { flex: COLS[5] }]}>
        {o.status === 'held'
          ? replacementCandidates(s).slice(0, 3).map((r) => (
              <Pressable key={r.id} disabled={!!blocked} onPress={() => mutate({ type: 'reassign', orderId: o.id, riderId: r.id })} style={({ pressed }) => [styles.chip, pressed && styles.chipPressed, !!blocked && styles.disabled]} accessibilityRole="button" accessibilityState={{ disabled: !!blocked }} accessibilityLabel={`${o.id}를 ${r.name}에게 대체 배차`}>
                <Txt style={styles.chipText}>{`→ ${r.name} (${activeOrders(s, r.id).length}건)`}</Txt>
              </Pressable>
            ))
          : <Txt style={styles.td}>{o.status === 'reassigned' ? `${owner} 배정 완료` : '-'}</Txt>}
      </View>
      <Txt style={[styles.td, styles.meta, { flex: COLS[6] }]} numberOfLines={3}>
        {last ? `${clockAt(s, last.t)} ${last.to}: ${last.text}${o.notices.length > 1 ? ` 외 ${o.notices.length - 1}건` : ''}` : '-'}
      </Txt>
    </View>
  );
}

function Count({ label, n, alert }: { label: string; n: number; alert?: boolean }) {
  return (
    <View style={styles.count}>
      <Txt style={[styles.countN, alert && styles.countAlert]}>{n}</Txt>
      <Txt style={styles.countLabel}>{label}</Txt>
    </View>
  );
}

function IncidentPanel({ s, analysis, compact = false }: { s: DemoState; analysis: SensorAnalysis | null; compact?: boolean }) {
  const blocked = presentationMutationBlock(usePresentationConnection());
  const i = s.incident;
  const stage = presentationStage(s, analysis ? { caseId: '', from: 0, to: 0, candidateAt: analysis.candidateAt, decision: analysis.decision } : null);
  if (!i) {
    return (
      <View style={styles.panel}>
        <Txt style={styles.colTitle}>사건</Txt>
        <Txt style={styles.calmTitle}>{stage.title}</Txt>
        <Txt style={[styles.meta, styles.gap]}>{stage.description}</Txt>
        {s.sensorLost ? <Txt style={[styles.meta, styles.gap, { color: colors.redInk }]}>{`${s.riders[0]!.name} 라이더 센서 신호 끊김 — 확인 필요`}</Txt> : null}
      </View>
    );
  }
  const left = waitLeft(s);
  const tone: BadgeTone = i.status === 'resolved' || i.status === 'rider_ok' ? 'neutral' : i.status === 'confirming' ? 'red' : 'redSolid';
  const passed = analysis?.evidence.filter((e) => e.passedAt !== null) ?? [];
  const canAck = i.status === 'escalated';
  const canAct = i.status === 'escalated' || i.status === 'acknowledged';
  return (
    <View style={[styles.panel, styles.panelInner]}>
      <View style={styles.riderHead}>
        <Txt style={styles.colTitle}>{i.id}</Txt>
        <Badge tone={tone} size="sm">{INCIDENT_STATUS_LABEL[i.status]}</Badge>
      </View>
      <Txt style={styles.incTitle}>{`${s.riders[0]!.name} · ${clockAt(s, i.detectedT)} 사고 후보`}</Txt>
      {compact ? <Txt style={styles.meta}>{stage.description}</Txt> : null}

      <Section title="라이더 응답">
        <Txt style={styles.strongLine}>
          {i.response ? `${RESPONSE_LABEL[i.response]}${i.respondedT !== null ? ` · ${clockAt(s, i.respondedT)}` : ''}` : `확인 대기 — ${Math.ceil(left ?? 0)}초 남음`}
        </Txt>
        {i.status === 'confirming' ? <Txt style={styles.meta}>응답이 없으면 관제에 접수되고 주문이 보류돼요</Txt> : null}
      </Section>

      {!compact ? <Section title="감지 근거">
        {analysis ? (
          <>
            <Txt style={styles.strongLine}>{evidenceHeadline(analysis)}</Txt>
            {passed.map((e) => (
              <Txt key={e.key} style={styles.meta}>{`${METRIC_LABEL[e.key]} ${e.value?.toFixed(e.unit === 'g' || e.unit === 'm/s' ? 2 : 0)}${UNIT[e.unit] ?? e.unit} ≥ ${e.threshold}${UNIT[e.unit] ?? e.unit} · ${e.passedAt?.toFixed(3)}초`}</Txt>
            ))}
            <Txt style={styles.meta}>{`규칙 ${analysis.ruleVersion} · 판정창 ${analysis.windowS}초 · 파형 ${i.caseId} (실측)`}</Txt>
          </>
        ) : (
          <Txt style={styles.meta}>판정 근거를 불러오는 중</Txt>
        )}
      </Section> : null}

      <Section title="대응">
        <Txt style={styles.meta}>{i.assignee ? `담당 ${i.assignee}${i.ackT !== null ? ` · 접수 ${clockAt(s, i.ackT)}` : ''}` : '담당자 없음'}</Txt>
        <Txt style={styles.meta}>{i.contactNotifiedT !== null ? `비상연락처 ${FIRST_CONTACT} 알림 · ${clockAt(s, i.contactNotifiedT)} (시연)` : '비상연락처 알림 전'}</Txt>
        {i.calls.map((c, k) => (
          <Txt key={k} style={styles.meta}>{`${clockAt(s, c.t)} 라이더 전화 — ${c.result}`}</Txt>
        ))}
        <View style={styles.actions}>
          {!compact || canAck ? <Button label={i.assignee ? `${CONTROLLER} 담당 중` : '접수하고 담당 지정'} size="sm" variant={canAck ? 'primary' : 'soft'} disabled={!canAck || !!blocked} onPress={() => mutate({ type: 'ack' })} /> : null}
          {!compact || canAct ?
          <View style={styles.actionRow}>
            <Button label="라이더에게 전화" size="sm" variant="outline" disabled={!canAct || !!blocked} onPress={() => mutate({ type: 'call' })} style={styles.flex} />
            <Button label="대응 완료" size="sm" variant={i.status === 'acknowledged' ? 'red' : 'soft'} disabled={i.status !== 'acknowledged' || !!blocked} onPress={() => mutate({ type: 'resolve' })} style={styles.flex} />
          </View> : null}
          {i.status === 'resolved' || i.status === 'rider_ok' ? <Button label="사건 보고서 열기" size="sm" variant="dark" onPress={openReport} /> : null}
        </View>
      </Section>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Txt style={styles.sectionTitle}>{title}</Txt>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  room: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 12, minWidth: 0 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  brand: { ...font.sans(800), fontSize: 17, letterSpacing: -0.4, color: colors.text },
  clock: { ...font.mono(600), fontSize: 15, color: colors.text, marginLeft: 6 },
  count: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  countN: { ...font.mono(700), fontSize: 17, color: colors.text },
  countAlert: { color: colors.red },
  countLabel: { ...typography.meta },
  main: { flexDirection: 'row', gap: 12, minHeight: 300 },
  mainStack: { flexDirection: 'column' },
  fullWidth: { width: '100%' },
  left: { width: 220, gap: 6 },
  center: { flex: 1, minWidth: 260, gap: 8 },
  right: { width: 320 },
  colTitle: { ...font.sans(700), fontSize: 13, lineHeight: 18, color: colors.textMuted },
  riderItem: { borderRadius: 12, padding: 9, backgroundColor: colors.surfaceMuted, gap: 2, borderWidth: 1.5, borderColor: 'transparent' },
  riderSel: { borderColor: colors.asphalt },
  riderAlert: { backgroundColor: colors.redSoft },
  riderHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  riderName: { ...font.sans(700), fontSize: 14, color: colors.text },
  riderSub: { ...typography.meta },
  logBox: { flex: 1, gap: 4, minHeight: 90 },
  logScroll: { maxHeight: 130 },
  logRow: { flexDirection: 'row', gap: 8, paddingVertical: 1.5 },
  logTime: { ...font.mono(600), fontSize: 11.5, color: colors.textFaint, width: 62 },
  logText: { ...font.sans(500), fontSize: 12.5, lineHeight: 17, color: colors.text, flex: 1 },
  panel: { backgroundColor: colors.surfaceMuted, borderRadius: 14, padding: 12 },
  panelInner: { gap: 8, paddingBottom: 8 },
  calmTitle: { ...font.sans(800), fontSize: 18, color: colors.text, marginTop: 8 },
  incTitle: { ...font.sans(800), fontSize: 16.5, lineHeight: 22, letterSpacing: -0.3, color: colors.text },
  section: { backgroundColor: colors.surface, borderRadius: 12, padding: 10, gap: 3 },
  sectionTitle: { ...font.sans(700), fontSize: 12, color: colors.textFaint, marginBottom: 2 },
  strongLine: { ...font.sans(700), fontSize: 14, lineHeight: 20, color: colors.text },
  meta: { ...typography.meta, color: colors.textMuted },
  gap: { marginTop: 6 },
  actions: { gap: 6, marginTop: 6 },
  actionRow: { flexDirection: 'row', gap: 6 },
  flex: { flex: 1, minWidth: 0 },
  orders: { gap: 2 },
  compactOrder: { gap: 5, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.divider },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.divider },
  th: { borderTopWidth: 0, paddingVertical: 4 },
  thText: { ...font.sans(600), fontSize: 11.5, color: colors.textFaint },
  td: { ...font.sans(500), fontSize: 12.5, lineHeight: 17, color: colors.text },
  mono: { ...font.mono(600), fontSize: 12 },
  strong: { ...font.sans(700) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: colors.asphalt },
  chipPressed: { backgroundColor: colors.asphaltPressed },
  disabled: { opacity: 0.45 },
  chipText: { ...font.sans(600), fontSize: 11.5, color: colors.textOnDark },
  empty: { ...typography.meta, paddingVertical: 8 },
});
