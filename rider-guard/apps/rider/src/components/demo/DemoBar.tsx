// 시연 조작 막대 — 시나리오 고르기 · 재생/일시정지/초기화 · 느린 재생 · 센서 끊김 · 응답 대기 건너뛰기 · 다른 화면 열기
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Badge, Button, Txt } from '@/components/ui';
import { inClip, LEAD_IN_S, SCENARIO_IDS, SCENARIOS, type DemoState, type EventClip } from '@/features/demo/engine';
import { dispatch, TAB_ID } from '@/features/demo/store';
import { mmss } from '@/lib/format';
import { colors, font, radius, typography } from '@/theme';

const open = (path: string) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(path, '_blank');
};

export function DemoBar({ s, clip, loading, error, links = true }: { s: DemoState; clip: EventClip | null; loading: boolean; error: unknown; links?: boolean }) {
  const phase = !clip ? null : s.t < LEAD_IN_S ? '정상 주행 (D7 실측 반복)' : inClip(s.t, clip) ? `사건 구간 · ${SCENARIOS[s.scenario].short} 실측 원본${s.slowmo ? ' · 느린 재생' : ''}` : '사건 이후';
  return (
    <View style={styles.bar}>
      <View style={styles.row}>
        {SCENARIO_IDS.map((id) => (
          <Pressable
            key={id}
            onPress={() => dispatch({ type: 'reset', scenario: id, baseWall: Date.now() })}
            style={[styles.scenario, s.scenario === id && styles.scenarioOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: s.scenario === id }}
          >
            <Txt style={[styles.scenarioText, s.scenario === id && styles.scenarioTextOn]}>{SCENARIOS[id].title}</Txt>
          </Pressable>
        ))}
      </View>
      <Txt style={styles.point}>{SCENARIOS[s.scenario].point}</Txt>
      <View style={styles.row}>
        <Button
          label={s.playing ? '일시정지' : s.t > 0 ? '이어서 재생' : '재생'}
          size="sm"
          variant={s.playing ? 'soft' : 'primary'}
          disabled={!clip}
          loading={!clip && loading}
          onPress={() => dispatch(s.playing ? { type: 'pause' } : { type: 'play', driver: TAB_ID })}
          style={styles.btn}
        />
        <Button label="처음부터" size="sm" variant="outline" onPress={() => dispatch({ type: 'reset', baseWall: Date.now() })} style={styles.btn} />
        <Toggle label="사건 구간 느리게" on={s.slowmo} onPress={() => dispatch({ type: 'slowmo', on: !s.slowmo })} />
        <Toggle label="헬멧 센서 끊기" on={s.sensorLost} onPress={() => dispatch({ type: 'sensor', lost: !s.sensorLost })} danger />
        {s.incident?.status === 'confirming' ? <Button label="응답 대기 건너뛰기" size="sm" variant="dark" onPress={() => dispatch({ type: 'skipWait' })} style={styles.btn} /> : null}
        <View style={styles.flex} />
        <Txt style={styles.time}>{`시연 ${mmss(s.t)}`}</Txt>
        {phase ? <Badge tone={clip && inClip(s.t, clip) ? 'red' : 'neutral'} size="sm">{phase}</Badge> : null}
      </View>
      {!clip ? (
        <Txt style={[styles.note, !!error && styles.err]}>
          {error ? '시연 데이터를 받지 못했어요 — 잠시 뒤 새로고침해 주세요' : '서버에서 실측 파형과 판정을 받는 중이에요 (서버가 잠들어 있으면 최대 1분)'}
        </Txt>
      ) : null}
      {links ? (
        <View style={styles.row}>
          <Link label="관제 화면만 새 창" onPress={() => open('/demo/control')} />
          <Link label="라이더 화면만 새 창" onPress={() => open('/demo/rider')} />
          <Link label="실험·시뮬레이션 결과" onPress={() => open('/demo/results')} />
          <Link label="사건 보고서" onPress={() => open('/demo/report')} />
          <Txt style={styles.note}>같은 브라우저의 창끼리는 같은 사건·같은 시계로 움직여요</Txt>
        </View>
      ) : null}
    </View>
  );
}

function Toggle({ label, on, onPress, danger }: { label: string; on: boolean; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, on && (danger ? styles.toggleDanger : styles.toggleOn)]} accessibilityRole="switch" accessibilityState={{ checked: on }}>
      <View style={[styles.dot, on && styles.dotOn]} />
      <Txt style={[styles.toggleText, on && styles.toggleTextOn]}>{label}</Txt>
    </Pressable>
  );
}

function Link({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link" hitSlop={4}>
      <Txt style={styles.link}>{label} ↗</Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  scenario: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted },
  scenarioOn: { backgroundColor: colors.asphalt },
  scenarioText: { ...font.sans(600), fontSize: 13, color: colors.text },
  scenarioTextOn: { color: colors.textOnDark },
  point: { ...typography.caption },
  btn: { paddingHorizontal: 16 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 12, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  toggleOn: { backgroundColor: colors.greenSoft },
  toggleDanger: { backgroundColor: colors.redSoft },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: colors.textFaint },
  dotOn: { backgroundColor: colors.asphalt, borderColor: colors.asphalt },
  toggleText: { ...font.sans(600), fontSize: 13, color: colors.textMuted },
  toggleTextOn: { color: colors.text },
  flex: { flex: 1 },
  time: { ...font.mono(700), fontSize: 15, color: colors.text },
  note: { ...typography.meta },
  err: { color: colors.redInk },
  link: { ...font.sans(600), fontSize: 13, color: colors.text, textDecorationLine: 'underline' },
});
