// 실험·시뮬레이션 결과 — 29조건 정상·사고 비교, 원본 파형, 판정 근거, 반복 편차, 누락·포화, 데이터 출처와 규칙 버전.
// 수치는 서버가 같은 판정 코드로 다시 계산한 것과, 원본 자료의 5회 요약을 그대로 보여 준다.
import type { DemoCaseSummaryDto, DemoRuleDto } from '@rider-guard/contract';
import Head from 'expo-router/head';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { evidenceHeadline, WaveChart } from '@/components/IncidentEvidence';
import { Badge, Txt, type BadgeTone } from '@/components/ui';
import { useDemoCase, useDemoResults } from '@/features/demo/data';
import { colors, font, radius, typography } from '@/theme';

const CLASS: Record<string, { label: string; tone: BadgeTone }> = {
  accident: { label: '사고', tone: 'red' },
  boundary: { label: '경계', tone: 'dark' },
  unrealized: { label: '미재현', tone: 'neutral' },
  normal: { label: '정상', tone: 'green' },
};
const DECISION: Record<string, string> = { candidate: '사고 후보', no_candidate: '후보 없음', insufficient: '후보 없음*' };
const KEY: Record<string, string> = { peak_g: '가속도', peak_gyro: '각속도', delta_v150: 'ΔV', bank_deg: '뱅크각' };
const pm = (v: [number, number], d: number) => `${v[0].toFixed(d)} ± ${v[1].toFixed(d)}`;
const ruleText = (r: DemoRuleDto) => `가속도 ≥ ${r.g}g 이면서 (각속도 ≥ ${r.gyro}°/s 또는 ΔV ≥ ${r.dv} m/s 또는 |뱅크각| ≥ ${r.bank}°) · 판정창 ${r.windowS}초`;

const COLS = [1.9, 0.7, 1.2, 1.1, 1, 0.7, 1, 1.3, 1.3, 0.6, 0.8];
const HEAD = ['조건', '분류', '가속도 피크 g\n5회 평균±SD', '각속도 °/s\n5회', 'ΔV 추정 m/s\n5회', '후보\n5회', '기록 첫 후보\n1회차', '운영 규칙\n1회차 판정', '발표자료 기준\n1회차 판정', '누락', 'ΔV 유효'];

export default function DemoResultsScreen() {
  const results = useDemoResults();
  const [selected, setSelected] = useState('A1');
  const r = results.data;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>Rider Guard 실험·시뮬레이션 결과</title>
      </Head>
      <Txt style={styles.h1}>실험·시뮬레이션 결과</Txt>
      {!r ? (
        <Txt style={styles.caption}>{results.isError ? '결과를 받지 못했어요 — 잠시 뒤 새로고침해 주세요' : '서버에서 29조건을 다시 판정하는 중이에요 (서버가 잠들어 있으면 최대 1분)'}</Txt>
      ) : (
        <>
          <View style={styles.source}>
            <Badge tone="neutral">{`출처: ${r.source.label}`}</Badge>
            <Txt style={styles.sourceText}>{r.source.note}. 파일 이름의 “REAL_”과 달리 실측이 아니에요. 화면의 모든 수치는 이 MOCK 자료에서만 나왔어요.</Txt>
            <Txt style={styles.sourceText}>
              “SIM 요약” 값은 기존 PCX125 시뮬레이션 보고서의 조건별 요약(다른 원본)이에요. 시뮬레이션 원본 시계열(pcx125_sim.zip)은 저장소에 없어 파형을 싣지 않았어요. 발표자료의 다른 집계(311회·337회)는 원본과 규칙 버전을 확인하지 못해 싣지 않았어요.
            </Txt>
          </View>

          <View style={styles.rules}>
            <View style={[styles.rule, styles.ruleMain]}>
              <Txt style={styles.ruleTitle}>{`운영 규칙 · ${r.rules.v1.version}`}</Txt>
              <Txt style={styles.ruleText}>{ruleText(r.rules.v1)}</Txt>
              <Txt style={styles.ruleMeta}>서버가 실제로 사고를 여는 규칙 — 보고서 초기값, 최적화 결과 아님</Txt>
            </View>
            <View style={styles.rule}>
              <Txt style={styles.ruleTitle}>{`발표자료 초안 기준 · ${r.rules.ppt.version}`}</Txt>
              <Txt style={styles.ruleText}>{ruleText(r.rules.ppt)}</Txt>
              <Txt style={styles.ruleMeta}>비교용 — 사고를 열지 않음. ΔV 기준은 초안에 없어 운영 규칙과 같게 둠</Txt>
            </View>
          </View>

          <Summary items={r.items} matched={r.matched} />

          <View style={styles.table}>
            <View style={[styles.tr, styles.th]}>
              {HEAD.map((h, k) => (
                <Txt key={h} style={[styles.thText, { flex: COLS[k] }]}>{h}</Txt>
              ))}
            </View>
            {r.items.map((i) => (
              <Row key={i.id} i={i} selected={selected === i.id} onPress={() => setSelected(i.id)} />
            ))}
            <Txt style={styles.foot}>* 판정창 안에 순번 누락이 있어 “판정 정보 부족”으로 남은 후보 없음. 5회 요약은 원본 자료 값(표본 SD), 1회차 판정은 서버가 1회차 원본 파형을 다시 판정한 값이에요. 1회차 29건 대조는 검출률·오경보율이 아니에요.</Txt>
          </View>

          <Detail id={selected} summary={r.items.find((i) => i.id === selected)!} />
        </>
      )}
    </ScrollView>
  );
}

function Summary({ items, matched }: { items: DemoCaseSummaryDto[]; matched: number }) {
  const by = (cls: string) => items.filter((i) => i.class === cls);
  const cand = (xs: DemoCaseSummaryDto[]) => xs.filter((i) => i.v1.decision === 'candidate').length;
  const acc = by('accident');
  const normal = by('normal');
  const edge = [...by('boundary'), ...by('unrealized')];
  const earlier = items.filter((i) => i.v1.candidateAt !== null && i.ppt.candidateAt !== null).map((i) => (i.v1.candidateAt! - i.ppt.candidateAt!) * 1000);
  return (
    <View style={styles.stats}>
      <Stat n={`${cand(acc)}/${acc.length}`} label="사고 조건 — 사고 후보" />
      <Stat n={`${cand(normal)}/${normal.length}`} label="정상 주행 — 사고 후보" />
      <Stat n={`${cand(edge)}/${edge.length}`} label={`경계·미재현 (${edge.map((i) => i.id).join('·')}) — 후보`} />
      <Stat n={`${matched}/${items.length}`} label="기록의 판정과 같은 표본에서 일치" />
      <Stat n={earlier.length ? `${Math.min(...earlier).toFixed(0)}~${Math.max(...earlier).toFixed(0)}ms` : '—'} label="발표자료 기준이 먼저 거는 시간" />
    </View>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Txt style={styles.statN}>{n}</Txt>
      <Txt style={styles.statLabel}>{label}</Txt>
    </View>
  );
}

function Row({ i, selected, onPress }: { i: DemoCaseSummaryDto; selected: boolean; onPress: () => void }) {
  const c = CLASS[i.class] ?? { label: i.class, tone: 'neutral' as BadgeTone };
  const pptDelta = i.v1.candidateAt !== null && i.ppt.candidateAt !== null ? (i.ppt.candidateAt - i.v1.candidateAt) * 1000 : null;
  return (
    <Pressable onPress={onPress} style={({ hovered }: { hovered?: boolean }) => [styles.tr, selected && styles.trSel, hovered && !selected && styles.trHover]} accessibilityRole="button" accessibilityState={{ selected }}>
      <Txt style={[styles.td, styles.strong, { flex: COLS[0] }]} numberOfLines={1}>{`${i.id} ${i.name}`}</Txt>
      <View style={{ flex: COLS[1] }}>
        <Badge tone={c.tone} size="sm">{c.label}</Badge>
      </View>
      <Txt style={[styles.td, styles.mono, { flex: COLS[2] }]}>{pm(i.repeats.peakG, 2)}</Txt>
      <Txt style={[styles.td, styles.mono, { flex: COLS[3] }]}>{pm(i.repeats.peakDps, 0)}</Txt>
      <Txt style={[styles.td, styles.mono, { flex: COLS[4] }]}>{pm(i.repeats.dvEst, 2)}</Txt>
      <Txt style={[styles.td, styles.mono, { flex: COLS[5] }]}>{`${i.repeats.candidates}/${i.repeats.n}`}</Txt>
      <Txt style={[styles.td, styles.mono, { flex: COLS[6] }]}>{i.latchAt === null ? '—' : `${i.latchAt.toFixed(3)}초`}</Txt>
      <Txt style={[styles.td, { flex: COLS[7] }, i.v1.decision === 'candidate' && styles.hit]}>{`${DECISION[i.v1.decision]}${i.v1.match ? ' ✓' : ' ✗'}`}</Txt>
      <Txt style={[styles.td, { flex: COLS[8] }]}>{`${DECISION[i.ppt.decision]}${pptDelta !== null ? ` (${pptDelta >= 0 ? '+' : ''}${pptDelta.toFixed(0)}ms)` : ''}`}</Txt>
      <Txt style={[styles.td, styles.mono, { flex: COLS[9] }]}>{String(i.quality.missingPackets)}</Txt>
      <Txt style={[styles.td, styles.mono, { flex: COLS[10] }]}>{i.quality.dvValidRatio === null ? '—' : `${Math.round(i.quality.dvValidRatio * 100)}%`}</Txt>
    </Pressable>
  );
}

function Detail({ id, summary }: { id: string; summary: DemoCaseSummaryDto }) {
  const q = useDemoCase(id);
  const a = q.data?.analysis;
  return (
    <View style={styles.detail}>
      <Txt style={styles.h2}>{`${summary.id} ${summary.name} — 1회차 원본 파형`}</Txt>
      {a ? (
        <>
          <Txt style={styles.strong}>{evidenceHeadline(a)}</Txt>
          <Txt style={styles.caption}>
            {`운영 규칙 통과 지표: ${summary.v1.passed.map((k) => KEY[k]).join(' + ') || '없음'} · 발표자료 기준 통과 지표: ${summary.ppt.passed.map((k) => KEY[k]).join(' + ') || '없음'} · 축 포화 ${summary.quality.saturated}건`}
          </Txt>
          <Txt style={styles.caption}>
            {`SIM 요약(다른 원본): 속도 ${summary.sim.speedKmh ?? '—'} km/h · 피크 ${summary.sim.peakG ?? '—'} g · ${summary.sim.peakDps ?? '—'} °/s · 실제 ΔV ${summary.sim.dvTrue ?? '—'} m/s · 후보 ${summary.sim.candidateS === null ? '없음' : `${summary.sim.candidateS}초`}`}
          </Txt>
          <View style={styles.charts}>
            {(['peak_g', 'peak_gyro', 'delta_v150', 'bank_deg'] as const).map((k) => (
              <View key={k} style={styles.chartCell}>
                <WaveChart a={a} metric={k} />
              </View>
            ))}
          </View>
          <Txt style={styles.foot}>점선 = 운영 규칙 기준 · 분홍 = 판정창 0.5초 · 빨간 선 = 사고 후보 시각 · 선이 끊긴 곳 = 결측·누락 · 빨간 눈금 = 축 포화</Txt>
        </>
      ) : (
        <Txt style={styles.caption}>{q.isError ? '파형을 받지 못했어요' : '파형을 불러오는 중'}</Txt>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, gap: 14, maxWidth: 1400, width: '100%', alignSelf: 'center' },
  h1: { ...font.sans(800), fontSize: 26, lineHeight: 34, letterSpacing: -0.6, color: colors.text },
  h2: { ...font.sans(800), fontSize: 17, color: colors.text },
  caption: { ...typography.caption },
  strong: { ...font.sans(700), fontSize: 13.5, lineHeight: 19, color: colors.text },
  source: { backgroundColor: colors.notice, borderRadius: radius.lg, padding: 14, gap: 6, alignItems: 'flex-start' },
  sourceText: { ...font.sans(500), fontSize: 13, lineHeight: 19, color: colors.noticeText },
  rules: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  rule: { flex: 1, minWidth: 320, backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 4 },
  ruleMain: { borderWidth: 2, borderColor: colors.asphalt },
  ruleTitle: { ...font.sans(700), fontSize: 13, color: colors.textMuted },
  ruleText: { ...font.sans(700), fontSize: 14.5, lineHeight: 21, color: colors.text },
  ruleMeta: { ...typography.meta },
  stats: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  stat: { flex: 1, minWidth: 180, backgroundColor: colors.surface, borderRadius: radius.card, padding: 14 },
  statN: { ...font.mono(700), fontSize: 24, color: colors.text },
  statLabel: { ...typography.caption },
  table: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14 },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, paddingHorizontal: 6, borderTopWidth: 1, borderTopColor: colors.divider, borderRadius: 6 },
  trSel: { backgroundColor: colors.surfaceMuted },
  trHover: { backgroundColor: colors.surfacePressed },
  th: { borderTopWidth: 0, alignItems: 'flex-end' },
  thText: { ...font.sans(600), fontSize: 11.5, lineHeight: 15, color: colors.textFaint },
  td: { ...font.sans(500), fontSize: 12.5, lineHeight: 17, color: colors.text },
  mono: { ...font.mono(600), fontSize: 12 },
  hit: { ...font.sans(700), color: colors.redInk },
  foot: { ...typography.meta, marginTop: 8 },
  detail: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 16, gap: 6 },
  charts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  chartCell: { flexGrow: 1, flexBasis: '45%', minWidth: 280 },
});
