import Head from 'expo-router/head';
import type { ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useToast } from '@/components/Toast';
import { TourActionButton, TourHelpButton, TourTarget, useGuidedTour } from '@/components/tour/GuidedTour';
import { Badge, Button, Txt } from '@/components/ui';
import { REPORT_ACTOR, REPORT_ORDER, REPORT_STATUS, type IncidentReport } from '@/features/demo/report';
import { colors, font, radius } from '@/theme';

const date = (value: string | null | undefined, timeOnly = false) => value ? new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', ...(timeOnly ? {} : { year: 'numeric', month: '2-digit', day: '2-digit' }), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(value)) : '—';
const number = (value: number | null, digits = 2) => value !== null && Number.isFinite(value) ? value.toFixed(digits) : '—';
const RESPONSE: Record<string, string> = { ok: '이상 없음 응답', help: '도움 요청', timeout: '응답 없음' };

function download(report: IncidentReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `BATON-${report.incident?.id ?? report.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReportMessage({ title, body, retry }: { title: string; body: string; retry?: () => void }) {
  return <View style={styles.empty}><Txt style={styles.kicker}>BATON / REPORT</Txt><Txt style={styles.title}>{title}</Txt><Txt style={styles.description}>{body}</Txt>{retry ? <Button label="다시 불러오기" onPress={retry} /> : null}</View>;
}

export function IncidentReportView({ report: r, structureOpen, openStructure, closeStructure, refreshing, stale, evidenceLoading, evidenceError, refresh }: {
  report: IncidentReport; structureOpen: boolean; openStructure: () => void; closeStructure: () => void;
  refreshing: boolean; stale: boolean; evidenceLoading: boolean; evidenceError: boolean; refresh: () => void;
}) {
  const tour = useGuidedTour();
  const toast = useToast();
  const i = r.incident;
  const rider = r.riders.find((rider) => rider.id === i?.riderId) ?? r.riders[0];
  const a = r.sourceSnapshot.analysis;
  const status = REPORT_STATUS[r.status] ?? r.status;
  const stored = !!r.receipt;
  const related = r.orders.filter((order) => order.status === 'reassigned').length;
  return <>
    {Platform.OS === 'web' ? <Head><style>{PRINT_CSS}</style></Head> : null}
    <ScrollView {...tour.scrollProps} nativeID="incident-report-scroll" style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.grow}><Txt style={styles.kicker}>BATON / INCIDENT REPORT</Txt><Txt accessibilityRole="header" style={styles.title}>사건 보고서</Txt><Txt style={styles.subtitle}>{i?.id ?? r.id}</Txt></View>
        <View nativeID="report-header-actions" style={styles.actions}><Button label="새로고침" variant="outline" size="sm" loading={refreshing} onPress={refresh} /><TourHelpButton name="report-help" /></View>
      </View>
      <TourTarget name="report-receipt" style={styles.receipt}>
        <View style={styles.actions}><Badge tone={stale ? 'red' : stored ? 'green' : 'neutral'}>{stale ? '연결 확인 필요' : stored ? '서버 저장 기록' : '브라우저 저장 기록'}</Badge><Txt style={styles.description}>{tour.active ? '도움말 진행 중 · 현재 기록 고정' : stale ? '마지막으로 수신한 기록을 표시합니다.' : '감지부터 대응까지 연결된 처리 기록'}</Txt></View>
        <Facts rows={[
          ['기록 ID', r.id], ['서버 수신', date(r.receipt?.receivedAt)], ['수신 순번', r.receipt ? `#${r.receipt.sequence}` : '—'], ['보고서 생성', date(r.generatedAt)],
        ]} />
      </TourTarget>
      <View style={styles.stats}>
        {[['처리 상태', status], ['담당 관제사', i?.assignee ?? '미지정'], ['주문 인계', `${related} / ${r.orders.length}건`], ['처리 이력', `${r.timeline.length}건`]].map(([label, value]) => <View key={label} style={styles.stat}><Txt style={styles.statLabel}>{label}</Txt><Txt style={styles.statValue}>{value}</Txt></View>)}
      </View>
      <Section target="report-incident" index="01" title="사건 요약" detail="사건 ID를 기준으로 라이더와 처리 결과를 연결합니다.">
        <Facts rows={[
          ['사건 ID', i?.id ?? '—'], ['라이더', rider ? `${rider.name} · ${rider.id}` : '—'], ['발생 위치', rider?.area ?? '—'], ['감지 시각', date(i?.detectedAt)],
          ['라이더 응답', i?.response ? RESPONSE[i.response] : i ? '응답 대기' : '—'], ['응답 시각', date(i?.respondedAt)], ['관제 접수', date(i?.acknowledgedAt)], ['종결 시각', date(i?.resolvedAt)],
        ]} />
      </Section>
      <Section target="report-metrics" index="02" title="감지 지표" detail="관측 최댓값과 판정 조건을 충족한 값을 구분합니다.">
        {r.metrics.length ? <>
          <Table headers={['지표 · 단위', '관측값', '기준값', '조건 충족']} rows={r.metrics.map((m) => [
            `${m.label}\n${m.unit}`, `${number(m.peak, m.decimals)}\n${m.basis === 'event_interval' ? '구간 최댓값' : m.basis === 'run_peak' ? '전체 최댓값' : '관찰창 값'}`, `${m.operator === 'abs>=' ? '|값| ≥' : '≥'} ${m.threshold}`, m.basis === 'event_interval' ? number(m.triggerValue, m.decimals) : m.fired === null ? '—' : m.fired ? '충족' : '미충족',
          ])} minWidth={520} />
          <Facts rows={[
            ['판정 규칙', a?.ruleVersion ?? r.sourceSnapshot.detection?.detector.version ?? '—'], ['판정창', `${a?.windowS ?? r.sourceSnapshot.detection?.detector.rule.window_s ?? '—'}초`],
            ['센서 후보 시각', i ? `${number(i.sensorTimeS, 3)}초` : '—'], ['관측 구간', a ? `${number(a.quality.interval.from, 3)}–${number(a.quality.interval.to, 3)}초` : '제공된 기록 기준'],
          ]} />
          {a ? <Table headers={['패킷 누락', '시각 이상', 'ΔV 유효 비율', '축 포화']} rows={[[a.quality.sequenceAvailable ? `${a.quality.missingPackets}개` : '—', `${a.quality.timeAnomalies}건`, a.quality.dvValidRatio === null ? '—' : `${Math.round(a.quality.dvValidRatio * 100)}%`, `${a.quality.saturation.length}건`]]} minWidth={440} /> : null}
        </> : <View style={styles.actions}><Txt style={styles.description}>{evidenceError ? '감지 지표를 불러오지 못했습니다.' : evidenceLoading ? '감지 지표를 불러오고 있습니다.' : r.status === 'monitoring' ? '감지 후 지표가 기록됩니다.' : '저장된 감지 지표가 없습니다.'}</Txt>{evidenceError ? <Button label="다시 불러오기" size="sm" variant="outline" onPress={refresh} /> : null}</View>}
      </Section>
      <Section target="report-timeline" index="03" title="대응 이력" detail="발생 시각과 처리 주체를 같은 형식으로 기록합니다.">
        <Table headers={['발생 시각 · KST', '경과 시간', '처리 주체', '처리 내용']} weights={[1.1, 0.7, 0.7, 2.5]} minWidth={660}
          rows={r.timeline.map((entry) => [date(entry.occurredAt, true), `+${number(entry.elapsedS, 1)}초`, REPORT_ACTOR[entry.actor] ?? entry.actor, `${entry.description}\n${entry.code}`])} empty="아직 기록된 대응이 없습니다." />
      </Section>
      <Section target="report-orders" index="04" title="주문 인계" detail="주문 ID로 담당자 변경과 안내 기록을 연결합니다.">
        <Table headers={['주문 ID', '가게 → 배달지', '이전 담당', '현재 담당', '처리 상태']} weights={[1, 2, 1, 1, 1]} minWidth={730}
          rows={r.orders.map((order) => [order.id, `${order.store}\n→ ${order.customer}`, `${order.originalRiderName}\n${order.originalRiderId}`, `${order.riderName}\n${order.riderId}`, REPORT_ORDER[order.status] ?? order.status])} empty="연결된 주문이 없습니다." />
        <Txt style={styles.subheading}>안내 기록 <Txt style={styles.count}>{r.notifications.length}건</Txt></Txt>
        <Table headers={['기록 시각 · KST', '주문 ID', '수신 대상', '안내 내용']} weights={[1.1, 1, 0.8, 2.7]} minWidth={680}
          rows={r.notifications.map((notice) => [date(notice.occurredAt, true), notice.orderId, notice.recipient, notice.message])} empty="저장된 안내 기록이 없습니다." />
      </Section>
      <Section target="report-storage" index="05" title="저장 및 내보내기" detail="화면의 기록과 원본 데이터를 같은 보고서로 보관합니다.">
        <View style={styles.actions}>
          <TourActionButton name="report-structure-open" label="저장 구조 보기" size="sm" variant="outline" onPress={openStructure} />
          {structureOpen ? <Button label="접기" size="sm" variant="ghost" onPress={closeStructure} /> : null}
        </View>
        {structureOpen ? <TourTarget name="report-structure" style={styles.structure}>
          <Facts rows={[
            ['저장 단위', stored ? '서버 수신 스냅샷 · 명령 순번' : '브라우저 상태 스냅샷'], ['서버 보관 기한', date(r.receipt?.expiresAt)],
            ['보고서 형식', r.schemaVersion], ['기록 출처', r.provenance.source?.kind === 'import' ? '외부 판정 기록' : a?.metadata.dataSource === 'measured' ? '헬멧 센서 측정 기록' : '브라우저 기록'],
          ]} />
          <Table headers={['기록 구분', 'JSON 필드', '연결 기준', '건수']} weights={[1, 1.6, 1.4, 0.5]} minWidth={570} rows={[
            ['사건', 'incident', '사건 ID', i ? '1' : '0'], ['라이더', 'riders', '라이더 ID', `${r.riders.length}`], ['감지 지표', 'metrics', '지표 코드', `${r.metrics.length}`],
            ['대응 이력', 'timeline', '사건 ID', `${r.timeline.length}`], ['주문', 'orders', '사건 ID · 주문 ID', `${r.orders.length}`], ['안내', 'notifications', '주문 ID', `${r.notifications.length}`], ['원본 스냅샷', 'sourceSnapshot', '기록 ID', '1'],
          ]} />
          <Txt style={styles.description}>보고서 항목은 수신된 원본에서 정리합니다. JSON에는 원본 스냅샷과 수신 정보가 함께 포함됩니다.</Txt>
        </TourTarget> : null}
        <TourTarget name="report-export" nativeID="report-export-actions" style={styles.export}>
          <View style={styles.grow}><Txt style={styles.subheading}>보고서 내보내기</Txt><Txt style={styles.description}>데이터 파일 또는 인쇄용 문서로 저장합니다.</Txt></View>
          <View style={styles.actions}>
            <Button label="JSON 저장" size="sm" disabled={Platform.OS !== 'web'} onPress={() => { try { download(r); toast.show('JSON 파일을 생성했습니다.'); } catch { toast.show('파일을 생성하지 못했습니다. 다시 시도해 주세요.'); } }} />
            <Button label="인쇄 · PDF 저장" size="sm" variant="outline" disabled={Platform.OS !== 'web'} onPress={() => window.print()} />
          </View>
        </TourTarget>
      </Section>
      <View style={styles.footer}><Txt style={styles.footerText}>BATON · 사고 대응 기록</Txt><Txt style={styles.footerText}>시각 KST · 센서 시각 상대 초 · 형식 v1</Txt></View>
    </ScrollView>
  </>;
}

function Section({ target, index, title, detail, children }: { target: string; index: string; title: string; detail: string; children: ReactNode }) {
  return <TourTarget name={target} style={styles.section}>
    <View style={styles.sectionHead}><Txt style={styles.index}>{index}</Txt><View style={styles.grow}><Txt accessibilityRole="header" style={styles.sectionTitle}>{title}</Txt><Txt style={styles.description}>{detail}</Txt></View></View>
    {children}
  </TourTarget>;
}
function Facts({ rows }: { rows: string[][] }) {
  return <View style={styles.facts}>{rows.map(([key, value]) => <View key={key} style={styles.fact}><Txt style={styles.factLabel}>{key}</Txt><Txt style={styles.factValue}>{value}</Txt></View>)}</View>;
}
function Table({ headers, rows, weights = headers.map(() => 1), minWidth, empty = '기록 없음' }: { headers: string[]; rows: string[][]; weights?: number[]; minWidth: number; empty?: string }) {
  return <ScrollView horizontal style={styles.tableScroll} contentContainerStyle={{ flexGrow: 1 }}>
    <View style={[styles.table, { minWidth, flex: 1 }]}>
      <View style={[styles.tableRow, styles.tableHead]}>{headers.map((header, col) => <Txt key={header} style={[styles.cell, styles.th, { flex: weights[col] }]}>{header}</Txt>)}</View>
      {rows.length ? rows.map((row, rowIndex) => <View key={rowIndex} style={[styles.tableRow, rowIndex % 2 === 1 && styles.alternate]} accessible accessibilityLabel={row.map((value, col) => `${headers[col]} ${value}`).join(', ')}>
        {row.map((value, col) => <Txt key={col} style={[styles.cell, { flex: weights[col] }]}>{value}</Txt>)}
      </View>) : <Txt style={styles.tableEmpty}>{empty}</Txt>}
    </View>
  </ScrollView>;
}

const PRINT_CSS = `@media print {
  html, body, #root, #root > div { height: auto !important; overflow: visible !important; }
  #root div:has(#incident-report-scroll) { position: static !important; display: block !important; height: auto !important; }
  #root div { overflow: visible !important; max-height: none !important; }
  #incident-report-scroll { display: block !important; position: static !important; height: auto !important; }
  #incident-report-scroll > div { padding: 0 !important; max-width: none !important; }
  #report-header-actions, #tour-report-export, #tour-report-structure-open { display: none !important; }
  #incident-report-scroll [id^="tour-report-"] { break-inside: auto; margin-bottom: 14px; }
  #incident-report-scroll [id^="tour-report-"] > div { min-width: 0 !important; }
  @page { size: A4 landscape; margin: 12mm; }
}`;

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 20, maxWidth: 1160, width: '100%', alignSelf: 'center' },
  empty: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  header: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, alignItems: 'center', paddingVertical: 12 },
  grow: { flex: 1, minWidth: 180 },
  kicker: { ...font.sans(700), fontSize: 11, letterSpacing: 1.5, color: colors.textMuted, marginBottom: 8 },
  title: { ...font.sans(800), fontSize: 30, lineHeight: 40, color: colors.text, letterSpacing: -0.8 },
  subtitle: { ...font.mono(500), fontSize: 12, lineHeight: 20, color: colors.textMuted, marginTop: 5 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  receipt: { borderRadius: radius.card, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface, padding: 18, gap: 14 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { flex: 1, minWidth: 145, padding: 16, gap: 10, backgroundColor: colors.surface, borderRadius: radius.lg },
  statLabel: { ...font.sans(500), fontSize: 12, color: colors.textMuted },
  statValue: { ...font.sans(700), fontSize: 18, lineHeight: 26, color: colors.text },
  section: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.divider, padding: 18, gap: 18, minWidth: 0 },
  sectionHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  index: { ...font.mono(600), color: colors.textMuted, fontSize: 13, lineHeight: 25 },
  sectionTitle: { ...font.sans(800), fontSize: 18, lineHeight: 26, color: colors.text, marginBottom: 4 },
  description: { ...font.sans(500), fontSize: 12, lineHeight: 19, color: colors.textMuted, flexShrink: 1 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: colors.divider },
  fact: { flexGrow: 1, flexBasis: '48%', minWidth: 210, paddingVertical: 12, paddingRight: 16, gap: 4, borderBottomWidth: 1, borderColor: colors.divider },
  factLabel: { ...font.sans(500), fontSize: 11, lineHeight: 16, color: colors.textMuted },
  factValue: { ...font.sans(600), fontSize: 13, lineHeight: 20, color: colors.text },
  tableScroll: { flexGrow: 0, maxWidth: '100%' },
  table: { borderWidth: 1, borderColor: colors.divider, borderRadius: radius.sm, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.divider },
  tableHead: { backgroundColor: colors.surfaceMuted },
  alternate: { backgroundColor: colors.bg },
  cell: { ...font.sans(500), fontSize: 12, lineHeight: 20, paddingVertical: 12, paddingHorizontal: 10, minWidth: 0, color: colors.text },
  th: { ...font.sans(700), fontSize: 11, color: colors.textMuted, paddingVertical: 9 },
  tableEmpty: { ...font.sans(500), fontSize: 12, color: colors.textMuted, padding: 16 },
  subheading: { ...font.sans(700), fontSize: 14, lineHeight: 21, color: colors.text },
  count: { ...font.sans(500), fontSize: 12, color: colors.textMuted },
  structure: { gap: 16 },
  export: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16, paddingTop: 18, borderTopWidth: 1, borderColor: colors.divider },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, paddingBottom: 20 },
  footerText: { ...font.sans(500), fontSize: 10, lineHeight: 17, color: colors.textMuted },
});
