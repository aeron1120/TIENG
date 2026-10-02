import type { SensorAnalysis, SensorMetricEvidence } from '@rider-guard/contract';
import { StyleSheet, View } from 'react-native';

import { Txt } from '@/components/ui';
import { colors, font, radius } from '@/theme';

const METRICS: { key: SensorMetricEvidence['key']; label: string; unit: string; digits: number }[] = [
  { key: 'peak_g', label: '합성 가속도', unit: 'g', digits: 2 },
  { key: 'peak_gyro', label: '합성 각속도', unit: '°/s', digits: 1 },
  { key: 'delta_v150', label: '속도 변화 ΔV', unit: 'm/s', digits: 2 },
  { key: 'bank_deg', label: '|뱅크각|', unit: '°', digits: 1 },
];

const number = (value: number | null | undefined, digits: number) =>
  value != null && Number.isFinite(value) ? value.toFixed(digits) : '—';

/** 서버가 제공한 사건 구간의 유효 최댓값. 조건 충족 시점의 값(value)과 섞지 않는다. */
export function SensorEvidenceTable({ analysis }: { analysis: SensorAnalysis }) {
  return <View style={styles.container}>
    <View style={styles.table}>
      <View style={[styles.row, styles.header]}>
        <Txt style={[styles.heading, styles.metric]}>지표</Txt>
        <Txt style={[styles.heading, styles.numeric]}>관측 최댓값</Txt>
        <Txt style={[styles.heading, styles.threshold]}>기준값</Txt>
      </View>
      {METRICS.map((metric) => {
        const evidence = analysis.evidence.find((entry) => entry.key === metric.key);
        const value = number(evidence?.peak, metric.digits);
        const threshold = evidence && Number.isFinite(evidence.threshold) ? `≥ ${evidence.threshold}` : '—';
        const unit = metric.key === 'delta_v150' ? `${analysis.dvWindowS * 1000}ms · ${metric.unit}` : metric.unit;
        return <View key={metric.key} style={styles.row} accessible accessibilityLabel={`${metric.label}, ${unit}, 관측 최댓값 ${value}, 기준값 ${threshold}`}>
          <View style={styles.metric}><Txt style={styles.label}>{metric.label}</Txt><Txt style={styles.unit}>{unit}</Txt></View>
          <Txt style={[styles.value, styles.numeric]}>{value}</Txt>
          <Txt style={[styles.limit, styles.threshold]}>{threshold}</Txt>
        </View>;
      })}
    </View>
    <Txt style={styles.note}>{`유효 표본 기준 · ${number(analysis.quality.interval.from, 3)}–${number(analysis.quality.interval.to, 3)}초`}</Txt>
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 7, minWidth: 0 },
  table: { borderWidth: 1, borderColor: colors.divider, borderRadius: radius.sm, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 9, borderTopWidth: 1, borderColor: colors.divider },
  header: { backgroundColor: colors.surfaceMuted, borderTopWidth: 0, paddingVertical: 7 },
  heading: { ...font.sans(600), fontSize: 11, lineHeight: 16, color: colors.textMuted },
  metric: { flex: 1.25, minWidth: 0 },
  numeric: { flex: 1, minWidth: 0, textAlign: 'right' },
  threshold: { flex: 0.8, minWidth: 0, textAlign: 'right' },
  label: { ...font.sans(600), fontSize: 12, lineHeight: 17, color: colors.text },
  unit: { ...font.sans(500), fontSize: 10, lineHeight: 15, color: colors.textMuted },
  value: { ...font.mono(600), fontSize: 13, lineHeight: 19, color: colors.text },
  limit: { ...font.mono(500), fontSize: 12, lineHeight: 18, color: colors.textMuted },
  note: { ...font.sans(500), fontSize: 10, lineHeight: 15, color: colors.textMuted },
});
