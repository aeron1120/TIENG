// 시연 화면의 실시간 파형 — 시연 시계에 맞춰 최근 3초를 흘려 보여 준다.
// 앞부분은 정상 주행 기록(반복), 이어서 사건 기록. 판정 기준선·판정창(0.5초)·후보 시각은 서버 판정 결과 그대로.
import type { SensorAnalysis } from '@rider-guard/contract';
import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';

import { Txt } from '@/components/ui';
import { candidateDemoT, clipLength, LEAD_IN_S, type EventClip } from '@/features/demo/engine';
import type { TimelinePoint } from '@/features/demo/data';
import { magnitudeOf, wavePaths, xOf, yMaxFor, type ChartBox, type WaveField } from '@/lib/waveform';
import { colors, font, radius, typography } from '@/theme';

const SPAN_S = 3;

type Metric = { key: SensorAnalysis['evidence'][number]['key']; field: WaveField; label: string; unit: string; digits: number };
const METRICS: Metric[] = [
  { key: 'peak_g', field: 'accG', label: '합성 가속도', unit: 'g', digits: 1 },
  { key: 'peak_gyro', field: 'gyroDps', label: '합성 각속도', unit: '°/s', digits: 0 },
  { key: 'delta_v150', field: 'dv150', label: '추정 ΔV (150ms)', unit: 'm/s', digits: 2 },
  { key: 'bank_deg', field: 'bankDeg', label: '추정 뱅크각 |값|', unit: '°', digits: 0 },
];

type Props = {
  timeline: TimelinePoint[];
  analysis: SensorAnalysis;
  clip: EventClip;
  t: number;
  /** 큰 화면은 2열, 좁으면 1열 */
  columns?: 1 | 2;
  height?: number;
};

export function LiveWave({ timeline, analysis, clip, t, columns = 2, height = 92 }: Props) {
  // 사건 기록이 끝나면 그 마지막 3초에 멈춘다 — 이후는 기록이 없어 빈 화면이 되므로
  const clipEnd = LEAD_IN_S + clipLength(clip);
  const end = Math.max(Math.min(t, clipEnd), SPAN_S);
  const visible = useMemo(() => timeline.filter((p) => p.t >= end - SPAN_S && p.t <= end), [timeline, end]);
  const cT = candidateDemoT(clip);
  return (
    <View style={styles.wrap}>
      {t > clipEnd ? <Txt style={styles.frozen}>기록 종료 · 마지막 3초</Txt> : null}
      <View style={[styles.grid, columns === 2 && styles.grid2]}>
      {METRICS.map((m) => (
        <View key={m.key} style={columns === 2 ? styles.cell2 : styles.cell1}>
          <Chart m={m} visible={visible} timeline={timeline} analysis={analysis} t0={end - SPAN_S} t1={end} now={t} cT={cT !== null && t >= cT ? cT : null} height={height} />
        </View>
      ))}
      </View>
    </View>
  );
}

function Chart({ m, visible, timeline, analysis, t0, t1, now, cT, height }: {
  m: Metric; visible: TimelinePoint[]; timeline: TimelinePoint[]; analysis: SensorAnalysis; t0: number; t1: number; now: number; cT: number | null; height: number;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width));
  const threshold = analysis.evidence.find((e) => e.key === m.key)?.threshold ?? 0;
  // 세로 축은 전체 기록 기준으로 고정 — 흐르는 동안 눈금이 흔들리지 않게
  const yMax = useMemo(() => yMaxFor(timeline, m.field, threshold), [timeline, m.field, threshold]);
  const box: ChartBox | null = width > 0 ? { width, height, t0, t1, yMax } : null;
  const paths = box ? wavePaths(visible, m.field, box) : [];
  const last = [...visible].reverse().find((p) => magnitudeOf(p, m.field) !== null);
  const current = last ? magnitudeOf(last, m.field) : null;
  const over = current !== null && current >= threshold;
  const yOfV = (v: number) => height - (Math.min(v, yMax) / yMax) * height;
  const inEvent = now >= LEAD_IN_S;

  return (
    <View accessible accessibilityLabel={`${m.label} 실시간 파형, 기준 ${threshold}${m.unit}, 현재 ${current === null ? '값 없음' : current.toFixed(m.digits)}`}>
      <View style={styles.head}>
        <Txt style={styles.label}>{m.label}</Txt>
        <Txt style={[styles.value, over && styles.valueOver]}>{current === null ? '값 없음' : `${current.toFixed(m.digits)} ${m.unit}`}</Txt>
      </View>
      <View onLayout={onLayout} style={[styles.plot, { height }]}>
        {box ? (
          <Svg width={box.width} height={height}>
            {/* 사건 기록 구간 배경 */}
            {inEvent ? <Rect x={Math.max(0, xOf(LEAD_IN_S, box))} y={0} width={box.width - Math.max(0, xOf(LEAD_IN_S, box))} height={height} fill={colors.surface} opacity={0.6} /> : null}
            {cT !== null ? (
              <Rect x={Math.max(0, xOf(cT - analysis.windowS, box))} y={0} width={Math.max(1, xOf(cT, box) - Math.max(0, xOf(cT - analysis.windowS, box)))} height={height} fill={colors.redSoft} />
            ) : null}
            <Line x1={0} x2={box.width} y1={yOfV(threshold)} y2={yOfV(threshold)} stroke={colors.red} strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
            {LEAD_IN_S > t0 && LEAD_IN_S < t1 ? <Line x1={xOf(LEAD_IN_S, box)} x2={xOf(LEAD_IN_S, box)} y1={0} y2={height} stroke={colors.textFaint} strokeWidth={1} strokeDasharray="2 3" /> : null}
            {paths.map((d, i) => (
              <Path key={i} d={d} stroke={colors.asphalt} strokeWidth={1.4} fill="none" />
            ))}
            {cT !== null ? <Line x1={xOf(cT, box)} x2={xOf(cT, box)} y1={0} y2={height} stroke={colors.red} strokeWidth={2} /> : null}
          </Svg>
        ) : null}
        {box && paths.length === 0 ? <Txt style={styles.noData}>{m.field === 'dv150' ? 'ΔV 계산 불가 구간 (값 없음)' : '값 없음'}</Txt> : null}
        <Txt style={styles.threshold}>{`기준 ${threshold}${m.unit === '°' ? '°' : ` ${m.unit}`}`}</Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  frozen: { ...typography.meta, color: colors.textMuted },
  grid: { gap: 12 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap' },
  cell1: { width: '100%' },
  cell2: { flexGrow: 1, flexBasis: '45%', minWidth: 240 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  label: { ...font.sans(600), fontSize: 12.5, lineHeight: 17, color: colors.text },
  value: { ...font.mono(600), fontSize: 13, lineHeight: 17, color: colors.textMuted },
  valueOver: { color: colors.red },
  plot: { borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, overflow: 'hidden', justifyContent: 'center' },
  noData: { ...typography.meta, position: 'absolute', alignSelf: 'center' },
  threshold: { ...typography.meta, fontSize: 10.5, position: 'absolute', right: 6, top: 3, color: colors.redInk },
});
