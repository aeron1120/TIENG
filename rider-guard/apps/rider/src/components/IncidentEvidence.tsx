// 사고 기록 상세의 '감지 근거' — 서버가 저장한 센서 판정(analysis)을 그대로 보여 준다.
// 감지 근거일 뿐 실제 사고 확정·부상 정도·보험 판단이 아니다. 없는 값은 지어내지 않고 '기록 없음'으로 둔다.
import type { DataSource, IncidentDetailDto, SensorAnalysis, SensorMetricEvidence } from '@rider-guard/contract';
import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';

import { Badge, Card, Divider, PressableScale, Txt, type BadgeTone } from '@/components/ui';
import { timeRange, wavePaths, xOf, yMaxFor, type ChartBox, type WaveField } from '@/lib/waveform';
import { colors, font, radius, typography } from '@/theme';

type Metric = SensorMetricEvidence['key'];

const METRIC: Record<Metric, { label: string; unit: string; field: WaveField; digits: number }> = {
  peak_g: { label: '합성 가속도', unit: 'g', field: 'accG', digits: 2 },
  peak_gyro: { label: '합성 각속도', unit: '°/s', field: 'gyroDps', digits: 0 },
  delta_v150: { label: '추정 ΔV (150ms)', unit: 'm/s', field: 'dv150', digits: 2 },
  bank_deg: { label: '추정 뱅크각 |값|', unit: '°', field: 'bankDeg', digits: 0 },
};

const SOURCE: Record<DataSource | 'unknown', { label: string; tone: BadgeTone }> = {
  measured: { label: '실측 데이터', tone: 'dark' },
  mock: { label: '모의 데이터', tone: 'neutral' },
  simulation: { label: '시뮬레이션', tone: 'neutral' },
  unknown: { label: '출처 미상', tone: 'neutral' },
};

const DECISION: Record<SensorAnalysis['decision'], string> = {
  candidate: '사고 후보 감지',
  no_candidate: '후보 조건 미충족',
  insufficient: '판정 정보 부족',
};

const REASON: Record<string, string> = {
  packet_gap: '패킷 순번 누락',
  sample_gap: '표본 간격 누락',
  time_anomaly: '센서 시각 이상',
  history_short: '150ms 이력 부족',
  missing_orientation_or_acceleration: '자세·가속도 입력 없음',
  missing_dv: 'ΔV 입력 없음',
  upstream_invalid: '장치에서 무효 처리',
  packet_or_time_gap: '누락 구간 포함',
};
const reasonText = (r: string) => REASON[r] ?? r;

const AXIS = ['X', 'Y', 'Z'];
const sec = (t: number | null) => (t === null ? '—' : `${t.toFixed(3)}초`);
const num = (v: number | null, digits: number) => (v === null ? '—' : v.toFixed(digits));

/** '사고 후보 감지 / ΔV 계산 불가 · 일부 누락' — 판정과 측정 품질을 한 줄로 */
export function evidenceHeadline(a: SensorAnalysis): string {
  const q = a.quality;
  const notes: string[] = [];
  if (!q.dvValid) notes.push(q.dvValidRatio ? 'ΔV 일부 계산 불가' : 'ΔV 계산 불가');
  if (q.missingPackets > 0) notes.push('일부 누락');
  if (q.timeAnomalies > 0) notes.push('시간 이상');
  if (q.saturation.length > 0) notes.push('축 포화');
  return notes.length ? `${DECISION[a.decision]} / ${notes.join(' · ')}` : DECISION[a.decision];
}

export function IncidentEvidence({ incident }: { incident: IncidentDetailDto }) {
  const [open, setOpen] = useState(false);
  const a = incident.analysis ?? null;
  const source = SOURCE[a?.metadata.dataSource ?? incident.dataSource ?? 'unknown'];

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Txt accessibilityRole="header" style={typography.heading}>
          감지 근거
        </Txt>
        <Badge tone={source.tone} size="sm">
          {source.label}
        </Badge>
      </View>

      {!a ? (
        <Txt style={styles.lead}>
          {incident.evidence != null
            ? '규칙 버전이 기록되기 전의 근거라 판정 지표와 측정 품질을 보여 줄 수 없어요.'
            : '센서 판정 근거가 저장되지 않은 기록이에요.'}
        </Txt>
      ) : (
        <>
          <Txt style={styles.decision}>{evidenceHeadline(a)}</Txt>
          <Txt style={styles.lead}>
            센서 수치가 규칙 조건을 넘었다는 기록이에요. 실제 사고 여부나 부상 정도를 판단한 결과가 아니에요.
          </Txt>

          <View style={styles.facts}>
            <Fact label="최초 후보 시각" value={a.candidateAt === null ? '없음' : `센서 ${sec(a.candidateAt)}`} />
            <Fact label="규칙" value={a.ruleVersion} mono />
            <Fact label="판정 창" value={`최근 ${a.windowS}초 · ΔV ${a.dvWindowS * 1000}ms · 시작 ${a.warmupS}초 후`} />
          </View>

          <Divider style={styles.divider} />
          {a.evidence.map((e) => (
            <MetricRow key={e.key} e={e} />
          ))}
          <Txt style={styles.rule}>
            조건: 최근 {a.windowS}초 안 가속도 ≥ {thresholdOf(a, 'peak_g')} g, 그리고 각속도 ≥ {thresholdOf(a, 'peak_gyro')}°/s · 유효 ΔV ≥{' '}
            {thresholdOf(a, 'delta_v150')} m/s · |뱅크각| ≥ {thresholdOf(a, 'bank_deg')}° 중 하나. 보고서의 초기 규칙값이며 최적화된 기준이 아니에요.
          </Txt>

          <PressableScale
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={open ? '측정 품질과 파형 접기' : '측정 품질과 파형 자세히 보기'}
            onPress={() => setOpen((v) => !v)}
            style={styles.toggle}
            pressedStyle={styles.togglePressed}
          >
            <Txt style={styles.toggleText}>{open ? '접기' : '측정 품질 · 파형 자세히'}</Txt>
          </PressableScale>

          {open ? <Details a={a} /> : null}
        </>
      )}
    </Card>
  );
}

const thresholdOf = (a: SensorAnalysis, key: Metric) => a.evidence.find((e) => e.key === key)?.threshold ?? '—';

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}, ${value}`}>
      <Txt style={styles.factLabel}>{label}</Txt>
      <Txt style={[styles.factValue, mono && styles.mono]}>{value}</Txt>
    </View>
  );
}

function MetricRow({ e }: { e: SensorMetricEvidence }) {
  const m = METRIC[e.key];
  const passed = e.passedAt !== null;
  const pass = passed ? `통과 ${num(e.value, m.digits)} ${m.unit} · ${sec(e.passedAt)}` : '판정 창에서 미통과';
  const peak = e.peak === null ? '값 없음' : `피크 ${num(e.peak, m.digits)} ${m.unit} · ${sec(e.peakAt)}`;
  return (
    <View style={styles.metric} accessible accessibilityLabel={`${m.label}, 기준 ${e.threshold} ${m.unit}, ${pass}, ${peak}`}>
      <View style={styles.metricMain}>
        <Txt style={styles.metricLabel}>{m.label}</Txt>
        <Txt style={styles.metricSub}>
          기준 ≥ {e.threshold} {m.unit}
        </Txt>
      </View>
      <View style={styles.metricValues}>
        <Txt style={[styles.metricPass, passed && styles.metricPassed]}>{pass}</Txt>
        <Txt style={styles.metricSub}>{peak}</Txt>
      </View>
    </View>
  );
}

function Details({ a }: { a: SensorAnalysis }) {
  const q = a.quality;
  const md = a.metadata;
  const unknown = '기록 없음';
  const ratio = q.dvValidRatio === null ? '계산할 표본 없음' : `${q.interval.valid}/${q.interval.eligible} 표본 (${Math.round(q.dvValidRatio * 100)}%)`;
  return (
    <View style={styles.details}>
      <Txt style={styles.subhead}>측정 품질</Txt>
      <KV k="패킷 누락" v={q.sequenceAvailable ? `${q.missingPackets}개` : '순번 정보 없음'} />
      <KV k="센서 시각 이상" v={`${q.timeAnomalies}건`} />
      <KV k="ΔV 유효 비율" v={ratio} />
      <KV k="ΔV 계산 구간" v={`센서 ${sec(q.interval.from)} ~ ${sec(q.interval.to)} (후보 전후 ${a.windowS}초, 판정 시작 이후 표본)`} />
      {!q.dvValid && q.dvInvalidReasons.length ? <KV k="ΔV 무효 사유" v={q.dvInvalidReasons.map(reasonText).join(', ')} /> : null}
      <KV
        k="축별 출력 레일 접근"
        v={
          q.saturation.length
            ? q.saturation
                .slice(0, 6)
                .map((s) => `${sec(s.t)} ${[...s.accAxes.map((i) => `가속 ${AXIS[i]}`), ...s.gyroAxes.map((i) => `자이로 ${AXIS[i]}`)].join('·')}`)
                .join(', ') + (q.saturation.length > 6 ? ` 외 ${q.saturation.length - 6}건` : '')
            : '없음 (|raw| ≥ 32760 기준)'
        }
      />
      {q.saturation.length ? <Txt style={styles.note}>포화 구간의 값은 실제 최대 충격이 아니라 센서 범위의 한계예요.</Txt> : null}

      <Txt style={[styles.subhead, styles.gapTop]}>장치 정보</Txt>
      <KV k="기록률" v={md.sampleRateHz ? `${md.sampleRateHz} Hz` : unknown} />
      <KV k="축별 범위" v={md.accRangeG || md.gyroRangeDps ? `±${md.accRangeG ?? '?'} g · ±${md.gyroRangeDps ?? '?'}°/s` : unknown} />
      <KV k="필터" v={md.filter || unknown} />
      <KV k="보정" v={md.calibration || unknown} />
      <KV k="장착" v={md.mount || unknown} />
      <KV k="출처 설명" v={md.provenance || unknown} />
      <KV k="시각 기준" v="판정·적분은 센서 시각(기록 시작 기준 초). 수신 시각은 따로 저장" />

      <Txt style={[styles.subhead, styles.gapTop]}>파형</Txt>
      <Txt style={styles.note}>빨간 세로선은 최초 후보 시각, 음영은 판정 창, 점선은 기준선이에요. 끊긴 선은 결측, 윗변의 빨간 표시는 포화 표본이에요.</Txt>
      {(['peak_g', 'peak_gyro', 'delta_v150', 'bank_deg'] as const).map((key) => (
        <WaveChart key={key} a={a} metric={key} />
      ))}
    </View>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv} accessible accessibilityLabel={`${k}, ${v}`}>
      <Txt style={styles.kvKey}>{k}</Txt>
      <Txt style={styles.kvValue}>{v}</Txt>
    </View>
  );
}

const CHART_H = 84;

function WaveChart({ a, metric }: { a: SensorAnalysis; metric: Metric }) {
  const [width, setWidth] = useState(0);
  const m = METRIC[metric];
  const threshold = a.evidence.find((e) => e.key === metric)?.threshold ?? 0;
  const range = timeRange(a.waveform);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width));
  const box: ChartBox | null = range && width > 0 ? { width, height: CHART_H, ...range, yMax: yMaxFor(a.waveform, m.field, threshold) } : null;
  const paths = box ? wavePaths(a.waveform, m.field, box) : [];
  const hasData = paths.length > 0;

  return (
    <View style={styles.chart} accessible accessibilityLabel={`${m.label} 파형, 단위 ${m.unit}, 기준 ${threshold}${hasData ? '' : ', 값 없음'}`}>
      <View style={styles.chartHead}>
        <Txt style={styles.chartLabel}>{m.label}</Txt>
        <Txt style={styles.chartUnit}>{box ? `0 ~ ${box.yMax.toFixed(m.digits)} ${m.unit}` : m.unit}</Txt>
      </View>
      <View onLayout={onLayout} style={styles.plot}>
        {box ? (
          <Svg width={box.width} height={CHART_H}>
            {a.candidateAt !== null ? (
              <Rect
                x={Math.max(0, xOf(a.candidateAt - a.windowS, box))}
                y={0}
                width={Math.max(1, xOf(a.candidateAt, box) - Math.max(0, xOf(a.candidateAt - a.windowS, box)))}
                height={CHART_H}
                fill={colors.redSoft}
              />
            ) : null}
            <Line
              x1={0}
              x2={box.width}
              y1={CHART_H - (threshold / box.yMax) * CHART_H}
              y2={CHART_H - (threshold / box.yMax) * CHART_H}
              stroke={colors.textFaint}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            {paths.map((d, i) => (
              <Path key={i} d={d} stroke={colors.asphalt} strokeWidth={1.4} fill="none" />
            ))}
            {a.waveform.map((p, i) =>
              p.saturated && (metric === 'peak_g' || metric === 'peak_gyro') ? (
                <Rect key={i} x={xOf(p.t, box) - 1} y={0} width={2} height={5} fill={colors.red} />
              ) : null,
            )}
            {a.candidateAt !== null ? (
              <Line x1={xOf(a.candidateAt, box)} x2={xOf(a.candidateAt, box)} y1={0} y2={CHART_H} stroke={colors.red} strokeWidth={1.5} />
            ) : null}
          </Svg>
        ) : null}
        {box && !hasData ? <Txt style={styles.noData}>이 지표는 기록된 값이 없어요</Txt> : null}
      </View>
      {range ? (
        <View style={styles.chartAxis}>
          <Txt style={styles.axisText}>{sec(range.t0)}</Txt>
          <Txt style={styles.axisText}>{sec(range.t1)}</Txt>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 16, paddingHorizontal: 16 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  decision: { ...font.sans(700), fontSize: 15, lineHeight: 22, letterSpacing: -0.3, color: colors.text, marginTop: 10 },
  lead: { ...typography.caption, marginTop: 4 },
  facts: { marginTop: 12, gap: 6 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  factLabel: { ...typography.caption },
  factValue: { ...font.sans(600), fontSize: 13, lineHeight: 19, color: colors.text, flexShrink: 1, textAlign: 'right' },
  mono: { ...font.mono(600) },
  divider: { marginVertical: 12 },
  metric: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6 },
  metricMain: { flex: 1, minWidth: 0 },
  metricLabel: { ...font.sans(600), fontSize: 14, lineHeight: 20, color: colors.text },
  metricValues: { alignItems: 'flex-end', flexShrink: 1 },
  metricPass: { ...font.sans(500), fontSize: 13, lineHeight: 19, color: colors.textFaint, textAlign: 'right' },
  metricPassed: { ...font.sans(700), color: colors.text },
  metricSub: { ...typography.meta, textAlign: 'right' },
  rule: { ...typography.meta, marginTop: 10 },
  toggle: { marginTop: 12, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  togglePressed: { backgroundColor: colors.curb },
  toggleText: { ...font.sans(600), fontSize: 13.5, lineHeight: 19, color: colors.text },
  details: { marginTop: 14, gap: 6 },
  subhead: { ...typography.section },
  gapTop: { marginTop: 10 },
  kv: { flexDirection: 'row', gap: 12 },
  kvKey: { ...typography.caption, width: 104 },
  kvValue: { ...font.sans(500), fontSize: 13, lineHeight: 19, color: colors.text, flex: 1 },
  note: { ...typography.meta },
  chart: { marginTop: 8 },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  chartLabel: { ...font.sans(600), fontSize: 12.5, lineHeight: 17, color: colors.text },
  chartUnit: { ...typography.meta },
  plot: { height: CHART_H, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, overflow: 'hidden', justifyContent: 'center' },
  noData: { ...typography.meta, position: 'absolute', alignSelf: 'center' },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  axisText: { ...typography.meta, fontSize: 11 },
});
