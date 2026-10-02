import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { API_URL } from '@/api/client';
import { Badge, Button, Txt } from '@/components/ui';
import { TourHelpButton, TourTarget } from '@/components/tour/GuidedTour';
import { presentationPlaybackActions, presentationStage } from '@/features/demo/display';
import { SCENARIO_IDS, SCENARIOS, type DemoState, type EventClip } from '@/features/demo/engine';
import { discardPresentation, getPresentationConnection, openPresentationReport, resumePresentation, retryPresentation, startPresentation, usePresentationConnection } from '@/features/demo/presentation';
import { demoViewPath, dispatch, getDemoState, TAB_ID } from '@/features/demo/store';
import { mmss } from '@/lib/format';
import { colors, font, radius, typography } from '@/theme';

const open = (url: string) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
};

export function PresentationPanel({ s, clip, loading, error, detail, onDetailChange }: {
  s: DemoState; clip: EventClip | null; loading: boolean; error: unknown; detail: boolean; onDetailChange: (detail: boolean) => void;
}) {
  const c = usePresentationConnection();
  const [automatic, setAutomatic] = useState(s.t > 0 ? s.autoPilot : true);
  const [advanced, setAdvanced] = useState(false);
  const linked = !!c.sessionId && !c.canResume;
  const busy = c.status === 'connecting' || c.status === 'restoring';
  const problem = c.status === 'error' || c.status === 'retrying';
  const stage = presentationStage(s, clip);
  const blocked = busy || c.status === 'retrying';
  const tone = stage.tone === 'danger' ? 'red' : stage.tone === 'success' ? 'green' : 'neutral';
  const status = c.status === 'restoring' ? '복구 중' : c.status === 'connecting' ? '연결 중' : c.canResume ? '이전 시연 있음' : problem ? '연결 확인 필요' : !linked ? '준비' : c.pending ? '동기화 중' : '연결됨';
  const start = async (fresh = false) => {
    if (fresh && c.canResume) discardPresentation();
    await startPresentation(automatic);
    if (!automatic && getPresentationConnection().sessionId && !['error', 'retrying'].includes(getPresentationConnection().status)) dispatch({ type: 'play', driver: TAB_ID });
  };
  const primary = async () => {
    if (c.canResume) {
      await resumePresentation();
      setAutomatic(getDemoState().autoPilot);
    } else if (!linked) await start();
    else presentationPlaybackActions(s, automatic, TAB_ID).forEach(dispatch);
  };
  const primaryLabel = c.canResume ? '이전 시연 이어가기' : s.playing ? '일시정지' : !linked || s.t === 0 ? '시작' : stage.finished ? '시연 종료' : '이어서 재생';
  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <Txt style={styles.brand}>Rider Guard</Txt>
        <Txt style={styles.note}>시연 · 실제 발송 없음</Txt>
        <Badge tone={problem ? 'red' : linked ? 'green' : 'neutral'} size="sm">{status}</Badge>
        <View style={styles.spacer} />
        <Txt style={styles.time}>{mmss(s.t)}</Txt>
        <TourTarget name="demo-view"><Choice label={detail ? '발표 보기' : '상세 보기'} selected={detail} onPress={() => onDetailChange(!detail)} /></TourTarget>
        <TourHelpButton name="demo-help" disabled={busy} />
      </View>
      <View style={styles.row}>
        <TourTarget name="demo-scenarios" style={styles.row}>
        {SCENARIO_IDS.map((id) => <Choice key={id} label={SCENARIOS[id].short} selected={s.scenario === id} disabled={blocked || c.canResume} onPress={() => dispatch({ type: 'reset', scenario: id, baseWall: Date.now() })} />)}
        </TourTarget>
        <View style={styles.spacer} />
        <TourTarget name="demo-playback" style={styles.row}>
        <Choice label="자동" selected={automatic} disabled={blocked || c.canResume} onPress={() => { setAutomatic(true); if (linked) dispatch({ type: 'autopilot', on: true }); }} />
        <Choice label="수동" selected={!automatic} disabled={blocked || c.canResume} onPress={() => { setAutomatic(false); if (linked) dispatch({ type: 'autopilot', on: false }); }} />
        <Button label={primaryLabel} variant={s.playing ? 'soft' : 'primary'} size="sm" loading={busy} disabled={!clip || blocked || (linked && stage.finished && !s.playing)} onPress={() => void primary()} />
        <Button label={c.canResume ? '새로 시작' : '다시 시작'} variant="outline" size="sm" disabled={!clip || busy} onPress={() => void start(true)} />
        </TourTarget>
      </View>
      <TourTarget name="demo-status" style={[styles.situation, stage.tone === 'danger' && styles.danger, stage.tone === 'warning' && styles.warning]}>
        <Badge tone={tone} size="sm">{stage.title}</Badge>
        {detail ? <Txt style={styles.sentence}>{stage.description}</Txt> : <View style={styles.spacer} />}
        {s.incident?.status === 'confirming' ? <Button label="대기 건너뛰기" size="sm" variant="outline" disabled={blocked || c.canResume} onPress={() => dispatch({ type: 'skipWait' })} /> : null}
        {(stage.finished || c.monitorUrl) ? <TourTarget name="demo-report"><Button label="보고서 ↗" variant="outline" size="sm" onPress={openPresentationReport} /></TourTarget> : null}
        <TourTarget name="demo-options"><Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(!advanced)}><Txt style={styles.link}>{advanced ? '옵션 닫기 ▴' : '옵션 ▾'}</Txt></Pressable></TourTarget>
      </TourTarget>
      {detail ? <View style={styles.row}>
        {['데이터 수신', '사고 판정', '라이더 확인', '연락·신고', '주문 인계', '결과'].map((label, index) => {
          const skipped = stage.skippedSteps.includes(index);
          return <Txt key={label} style={[styles.step, index === stage.step && styles.current, skipped && styles.skipped]}>{`${index + 1} ${label}${skipped ? ' · 생략' : index === stage.step ? ' · 현재' : ''}`}</Txt>;
        })}
      </View> : null}
      {!clip ? <Txt accessibilityRole={error ? 'alert' : undefined} style={[styles.note, !!error && styles.error]}>{error ? '데이터 수신 실패 · 새로고침해 주세요.' : loading ? '실측 데이터 불러오는 중…' : '시연 준비 중…'}</Txt> : null}
      {problem ? <View style={styles.row}><Txt accessibilityRole="alert" style={styles.error}>{c.message}</Txt>{c.status === 'retrying' ? <Button label="수신 다시 확인" variant="outline" size="sm" onPress={retryPresentation} /> : null}</View> : null}
      {c.message && !problem && !busy && (detail || (c.status === 'idle' && !c.canResume)) ? <Txt style={styles.note}>{c.message}</Txt> : null}
      {c.storageWarning ? <Txt accessibilityRole="alert" style={styles.error}>{c.storageWarning}</Txt> : null}
      {advanced ? <View style={styles.advanced}>
        <Txt style={styles.note}>{SCENARIOS[s.scenario].point}{automatic ? ' · 자동 모드는 응답 대기 후 관제와 주문 인계를 진행해요.' : ' · 수동 모드는 라이더와 관제 버튼을 직접 눌러 진행해요.'}</Txt>
        <View style={styles.row}>
          <Choice label="사건 구간 느리게" selected={s.slowmo} disabled={blocked || c.canResume} onPress={() => dispatch({ type: 'slowmo', on: !s.slowmo })} />
          <Choice label="헬멧 센서 끊기" selected={s.sensorLost} disabled={blocked || c.canResume} onPress={() => dispatch({ type: 'sensor', lost: !s.sensorLost })} />
          <Button label="운영 모니터 ↗" variant="outline" size="sm" onPress={() => open(c.monitorUrl ?? `${API_URL}/ops/presentation`)} />
          <Button label="관제만 ↗" variant="outline" size="sm" onPress={() => open(demoViewPath('/demo/control'))} />
          <Button label="라이더만 ↗" variant="outline" size="sm" onPress={() => open(demoViewPath('/demo/rider'))} />
          <Button label="라이더 홈 ↗" variant="outline" size="sm" onPress={() => open('/demo/home')} />
          <Button label="실험 결과 ↗" variant="outline" size="sm" onPress={() => open('/demo/results')} />
        </View>
        {c.receivedAt ? <Txt style={styles.note}>{`서버 수신 ${new Date(c.receivedAt).toLocaleTimeString('ko-KR', { hour12: false })} · 명령 ${c.acknowledged}건 확인 · 수신 성공은 사고 판정이나 구조 완료를 뜻하지 않아요.`}</Txt> : null}
      </View> : null}
      {detail || advanced ? <Txt style={styles.note}>실측 파형 · 라이더·주문·위치는 시연 데이터 · 문자·119·외부 배차 실제 발송 없음</Txt> : null}
    </View>
  );
}

function Choice({ label, selected, disabled = false, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, selected && styles.choiceOn, disabled && styles.disabled]}><Txt style={[styles.choiceText, selected && styles.choiceTextOn]}>{label}</Txt></Pressable>;
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, alignItems: 'center' },
  brand: { ...font.sans(800), fontSize: 19, lineHeight: 26, letterSpacing: -0.4, color: colors.text },
  spacer: { flexGrow: 1 },
  time: { ...font.mono(700), fontSize: 15, color: colors.text, marginRight: 6 },
  choice: { paddingHorizontal: 11, paddingVertical: 9, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  choiceOn: { backgroundColor: colors.asphalt },
  choiceText: { ...font.sans(600), fontSize: 13, color: colors.text },
  choiceTextOn: { color: colors.textOnDark },
  disabled: { opacity: 0.5 },
  situation: { backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, padding: 10, gap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  danger: { backgroundColor: colors.redSoft },
  warning: { backgroundColor: colors.notice },
  sentence: { ...typography.caption, color: colors.text, flexGrow: 1, flexShrink: 1, flexBasis: 320, minWidth: 0 },
  step: { ...font.sans(500), fontSize: 12, lineHeight: 18, color: colors.textMuted, paddingHorizontal: 7, paddingVertical: 3 },
  current: { ...font.sans(700), color: colors.text, backgroundColor: colors.surfaceMuted, borderRadius: radius.sm },
  skipped: { color: colors.textFaint },
  advanced: { gap: 8, borderTopWidth: 1, borderColor: colors.divider, paddingTop: 10 },
  note: { ...typography.meta },
  error: { ...typography.caption, color: colors.redInk, flexShrink: 1 },
  link: { ...font.sans(600), fontSize: 12, lineHeight: 18, color: colors.text, textDecorationLine: 'underline', padding: 5 },
});
