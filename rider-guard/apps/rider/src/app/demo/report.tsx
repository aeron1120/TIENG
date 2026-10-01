// 사건 보고서 (시연) — 감지부터 라이더 응답·관제 조치·주문 처리까지 같은 사건으로 묶어 보여 주고 내려받는다.
// 통합 시연·관제 화면과 같은 브라우저 저장소에서 마지막 상태를 이어 받는다.
import type { SensorAnalysis } from '@rider-guard/contract';
import Head from 'expo-router/head';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';

import { evidenceHeadline, WaveChart } from '@/components/IncidentEvidence';
import { Badge, Button, Txt } from '@/components/ui';
import { useDemoCase } from '@/features/demo/data';
import {
  clockAt,
  CONTROLLER,
  FIRST_CONTACT,
  INCIDENT_STATUS_LABEL,
  MAIN_RIDER,
  RESPONSE_LABEL,
  RESPONSE_WAIT_S,
  SCENARIOS,
  type DemoState,
} from '@/features/demo/engine';
import { useDemoState } from '@/features/demo/store';
import { presentationStage } from '@/features/demo/display';
import { openPresentationReport, usePresentationConnection } from '@/features/demo/presentation';
import { colors, font, radius, typography } from '@/theme';

const ACTOR: Record<string, string> = { system: '시스템', sensor: '센서 판정', rider: '라이더', control: '관제', order: '주문' };
const METRIC: Record<string, string> = { peak_g: '합성 가속도', peak_gyro: '합성 각속도', delta_v150: '추정 ΔV (150ms)', bank_deg: '추정 뱅크각' };
const UNIT: Record<string, string> = { g: 'g', 'deg/s': '°/s', 'm/s': 'm/s', deg: '°' };
const fmt = (v: number | null, unit: string) => (v === null ? '—' : `${v.toFixed(unit === 'g' || unit === 'm/s' ? 2 : 0)}${UNIT[unit] ?? unit}`);

function buildJson(s: DemoState, a: SensorAnalysis | null) {
  const i = s.incident!;
  return {
    schemaVersion: 'demo-incident-report-v1',
    source: 'local-browser-replay',
    serverReceivedAt: null,
    notice: '시연 데이터로 만든 사건 보고서입니다. 센서 파형은 ESP32·MPU6050 헬멧 IMU 실측 기록(시나리오 재현 실험)이고, 라이더·주문·관제·연락은 시연 데이터이며 실제로 아무에게도 발송하지 않았습니다. 사고 확정·상해 정도·보험 판단 자료가 아닙니다.',
    generatedAt: new Date().toISOString(),
    incident: { ...i, detectedAt: clockAt(s, i.detectedT), scenario: SCENARIOS[s.scenario].title },
    rider: s.riders.find((r) => r.id === MAIN_RIDER),
    sensor: a ? { ruleVersion: a.ruleVersion, windowS: a.windowS, decision: a.decision, candidateAt: a.candidateAt, headline: evidenceHeadline(a), evidence: a.evidence, quality: a.quality, metadata: a.metadata } : null,
    timeline: s.log.filter((l) => l.t >= i.detectedT - 0.001).map((l) => ({ at: clockAt(s, l.t), sinceDetectionS: +(l.t - i.detectedT).toFixed(2), actor: l.actor, text: l.text })),
    orders: s.orders.filter((o) => o.originalRiderId === MAIN_RIDER),
  };
}

function download(s: DemoState, a: SensorAnalysis | null) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(buildJson(s, a), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `rider-guard-${s.incident!.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DemoReportScreen() {
  const s = useDemoState();
  const c = usePresentationConnection();
  const i = s.incident;
  const serverContext = !!(c.sessionId || c.monitorUrl);
  const event = useDemoCase(serverContext ? null : i?.caseId ?? null);
  const a = event.data?.analysis ?? null;

  // A separate tab can hold an unrelated local replay. Prefer the shared read-only
  // server result before rendering or requesting evidence for any local incident.
  if (serverContext) return (
    <View style={styles.emptyPage}>
      <Head><title>발표 서버 수신 결과</title></Head>
      <Badge tone="green">서버 세션 결과</Badge>
      <Txt style={styles.h1}>{c.monitorUrl ? '발표의 수신 결과와 보고서' : '서버 보고서 읽기 링크를 확인할 수 없어요'}</Txt>
      <Txt style={styles.caption}>{c.monitorUrl ? '이 브라우저의 로컬 재생 기록과 서버에 수신된 기록은 다를 수 있어요. 연결된 발표의 읽기 전용 결과에서 사건·정상·판정 불가와 서버 수신 시각을 확인해 주세요.' : '발표 세션은 확인했지만 이 탭에서 읽기 전용 링크를 가져오지 못했어요. 시연을 시작한 원본 탭에서 수신 결과·보고서를 열어 주세요. 이 화면에서는 로컬 사건 기록을 대신 표시하지 않아요.'}</Txt>
      {c.monitorUrl ? <Button label="서버 수신 결과·보고서 열기 ↗" onPress={openPresentationReport} /> : null}
      <Txt style={styles.caption}>라이더 취소는 사고 없음의 확정이 아니며, 시연 대응 종결은 실제 구조 완료를 뜻하지 않아요.</Txt>
    </View>
  );

  if (!i) {
    const stage = presentationStage(s, null);
    return (
      <View style={styles.emptyPage}>
        <Badge tone="neutral">로컬 재생 결과</Badge>
        <Txt style={styles.h1}>{s.clipDone ? stage.title : '아직 로컬 사건이 없어요'}</Txt>
        <Txt style={styles.caption}>{stage.description}</Txt>
        <Txt style={styles.caption}>이 화면은 같은 브라우저에 저장된 마지막 재생 기록이에요. 연결된 서버 보고서 주소가 없어 서버 수신 시각이나 수신 완료를 확인할 수 없어요.</Txt>
      </View>
    );
  }
  const orders = s.orders.filter((o) => o.originalRiderId === MAIN_RIDER);
  const rider = s.riders.find((r) => r.id === MAIN_RIDER)!;
  const timeline = s.log.filter((l) => l.t >= i.detectedT - 0.001);
  const nameOf = (id: string) => s.riders.find((r) => r.id === id)?.name ?? id;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>{`사건 보고서 ${i.id}`}</title>
      </Head>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Txt style={styles.kicker}>Rider Guard · 로컬 재생 보고서 (시연)</Txt>
          <Txt style={styles.h1}>{i.id}</Txt>
          <Txt style={styles.caption}>{`${SCENARIOS[s.scenario].title} · 생성 ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`}</Txt>
        </View>
        <Badge tone={i.status === 'resolved' || i.status === 'rider_ok' ? 'neutral' : 'red'}>{INCIDENT_STATUS_LABEL[i.status]}</Badge>
      </View>
      <View style={styles.notice}>
        <Txt style={styles.noticeText}>
          같은 브라우저에 저장된 마지막 로컬 재생 기록이에요. 서버 수신 결과나 수신 시각을 확인한 보고서가 아니에요. 센서 파형은 ESP32·MPU6050 헬멧 IMU 실측 실험이고 라이더·주문·관제·연락은 시연 데이터라 실제로 발송하지 않았어요. 사고 확정·상해 정도·보험 판단이나 실제 구조 완료를 뜻하지 않아요.
        </Txt>
      </View>
      <View style={styles.buttons}>
        <Button label="인쇄 · PDF로 저장" size="sm" onPress={() => Platform.OS === 'web' && window.print()} style={styles.btn} />
        <Button label="JSON 내려받기" size="sm" variant="outline" onPress={() => download(s, a)} style={styles.btn} />
      </View>

      <Section title="1. 요약">
        <KV k="기록 출처" v="이 브라우저의 로컬 재생 · 서버 수신 시각 확인 불가" />
        <KV k="라이더" v={`${rider.name} · ${rider.area}`} />
        <KV k="감지" v={`${clockAt(s, i.detectedT)} 사고 후보 (센서 파형 ${i.candidateClipT.toFixed(3)}초)`} />
        <KV k="라이더 응답" v={i.response ? `${RESPONSE_LABEL[i.response]}${i.respondedT !== null ? ` · ${clockAt(s, i.respondedT)}` : ''}` : '응답 대기'} />
        <KV k="관제 접수" v={i.ackT !== null ? `${i.assignee} · ${clockAt(s, i.ackT)} (감지 후 ${(i.ackT - i.detectedT).toFixed(0)}초)` : i.status === 'rider_ok' ? '접수 없음 — 라이더가 괜찮다고 응답' : '접수 전'} />
        <KV k="비상연락" v={i.contactNotifiedT !== null ? `${FIRST_CONTACT} · ${clockAt(s, i.contactNotifiedT)} 위치 공유 (시연)` : '알리지 않음'} />
        <KV k="주문" v={orders.map((o) => `${o.id} ${o.status === 'reassigned' ? `→ ${nameOf(o.riderId)} 대체 배차` : o.status === 'held' ? '보류' : '배달 계속'}`).join(' · ') || '없음'} />
        <KV k="종결" v={i.resolvedT !== null ? `${clockAt(s, i.resolvedT)} · ${i.assignee ?? CONTROLLER}` : i.status === 'rider_ok' ? '라이더 응답으로 감시 복귀' : '진행 중'} />
      </Section>

      <Section title="2. 시간 구분">
        <KV k="센서 판정" v={`파형 기록 기준 ${i.candidateClipT.toFixed(3)}초에 판정창 0.5초 안에서 조건 충족 — 센서·판정 쪽 시각`} />
        <KV k="응답 대기" v={`${RESPONSE_WAIT_S}초 — 운영 설정값 (센서 판정 지연과 별개)`} />
        {i.escalatedT !== null ? <KV k="관제 접수까지" v={`감지 후 ${(i.escalatedT - i.detectedT).toFixed(1)}초 (${i.response === 'help' ? '도움 요청' : '무응답'})`} /> : null}
      </Section>

      <Section title="3. 감지 근거">
        {a ? (
          <>
            <Txt style={styles.strong}>{evidenceHeadline(a)}</Txt>
            <Txt style={styles.caption}>{`규칙 ${a.ruleVersion} · 판정창 ${a.windowS}초 · ΔV 창 ${a.dvWindowS}초 · 출처 ${a.metadata.provenance ?? a.metadata.dataSource}`}</Txt>
            <View style={[styles.tr, styles.th]}>
              {['지표', '기준', '통과 값', '통과 시각', '피크', '피크 시각'].map((h) => (
                <Txt key={h} style={[styles.thText, styles.cell]}>{h}</Txt>
              ))}
            </View>
            {a.evidence.map((e) => (
              <View key={e.key} style={styles.tr}>
                <Txt style={[styles.td, styles.cell]}>{METRIC[e.key]}</Txt>
                <Txt style={[styles.td, styles.cell]}>{`≥ ${e.threshold}${UNIT[e.unit] ?? e.unit}`}</Txt>
                <Txt style={[styles.td, styles.cell, e.value !== null && styles.strong]}>{fmt(e.value, e.unit)}</Txt>
                <Txt style={[styles.td, styles.cell]}>{e.passedAt === null ? '—' : `${e.passedAt.toFixed(3)}초`}</Txt>
                <Txt style={[styles.td, styles.cell]}>{fmt(e.peak, e.unit)}</Txt>
                <Txt style={[styles.td, styles.cell]}>{e.peakAt === null ? '—' : `${e.peakAt.toFixed(3)}초`}</Txt>
              </View>
            ))}
            <Txt style={styles.caption}>{`측정 품질: 순번 누락 ${a.quality.missingPackets}개 · ΔV ${a.quality.dvValid ? '유효' : `일부 계산 불가 (유효 ${Math.round((a.quality.dvValidRatio ?? 0) * 100)}%, ${a.quality.dvInvalidReasons.join(', ')})`} · 축 포화 ${a.quality.saturation.length}건`}</Txt>
            <View style={styles.charts}>
              {(['peak_g', 'peak_gyro', 'delta_v150', 'bank_deg'] as const).map((k) => (
                <View key={k} style={styles.chartCell}>
                  <WaveChart a={a} metric={k} />
                </View>
              ))}
            </View>
          </>
        ) : (
          <Txt style={styles.caption}>{event.isError ? '판정 근거를 불러오지 못했어요' : '판정 근거를 불러오는 중'}</Txt>
        )}
      </Section>

      <Section title="4. 시간순 기록">
        {timeline.map((l, k) => (
          <View key={k} style={styles.tr}>
            <Txt style={[styles.td, styles.mono, { width: 74 }]}>{clockAt(s, l.t)}</Txt>
            <Txt style={[styles.td, styles.mono, { width: 64, color: colors.textFaint }]}>{`+${(l.t - i.detectedT).toFixed(1)}초`}</Txt>
            <Txt style={[styles.td, { width: 70 }]}>{ACTOR[l.actor]}</Txt>
            <Txt style={[styles.td, styles.flex]}>{l.text}</Txt>
          </View>
        ))}
      </Section>

      <Section title="5. 주문 처리">
        {orders.map((o) => (
          <View key={o.id} style={styles.order}>
            <Txt style={styles.strong}>{`${o.id} · ${o.store} → ${o.customer}`}</Txt>
            <Txt style={styles.caption}>{`담당 ${nameOf(o.originalRiderId)}${o.riderId !== o.originalRiderId ? ` → ${nameOf(o.riderId)}` : ''} · ${o.status === 'reassigned' ? '대체 배차' : o.status === 'held' ? `보류 (${o.holdReason})` : '배달 계속'}`}</Txt>
            {o.notices.map((n, k) => (
              <Txt key={k} style={styles.caption}>{`${clockAt(s, n.t)} ${n.to} 안내: ${n.text} (시연 — 실제 발송 없음)`}</Txt>
            ))}
          </View>
        ))}
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Txt style={styles.h2}>{title}</Txt>
      {children}
    </View>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv}>
      <Txt style={styles.kvK}>{k}</Txt>
      <Txt style={styles.kvV}>{v}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, gap: 14, maxWidth: 920, width: '100%', alignSelf: 'center' },
  emptyPage: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, backgroundColor: colors.bg },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  kicker: { ...font.sans(700), fontSize: 13, color: colors.textMuted },
  h1: { ...font.sans(800), fontSize: 26, lineHeight: 34, letterSpacing: -0.6, color: colors.text },
  h2: { ...font.sans(800), fontSize: 16, color: colors.text, marginBottom: 4 },
  caption: { ...typography.caption },
  strong: { ...font.sans(700), fontSize: 14, lineHeight: 20, color: colors.text },
  notice: { backgroundColor: colors.notice, borderRadius: radius.lg, padding: 12 },
  noticeText: { ...font.sans(500), fontSize: 13, lineHeight: 19, color: colors.noticeText },
  buttons: { flexDirection: 'row', gap: 8 },
  btn: { paddingHorizontal: 16 },
  section: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 16, gap: 6 },
  kv: { flexDirection: 'row', gap: 12, paddingVertical: 2 },
  kvK: { ...typography.caption, width: 96 },
  kvV: { ...font.sans(600), fontSize: 13.5, lineHeight: 19, color: colors.text, flex: 1 },
  tr: { flexDirection: 'row', gap: 8, paddingVertical: 5, borderTopWidth: 1, borderTopColor: colors.divider, alignItems: 'flex-start' },
  th: { borderTopWidth: 0 },
  thText: { ...font.sans(600), fontSize: 12, color: colors.textFaint },
  td: { ...font.sans(500), fontSize: 13, lineHeight: 18, color: colors.text },
  cell: { flex: 1 },
  mono: { ...font.mono(600), fontSize: 12 },
  charts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  chartCell: { flexGrow: 1, flexBasis: '45%', minWidth: 260 },
  order: { gap: 2, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.divider },
});
