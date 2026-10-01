import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { API_URL } from '@/api/client';
import { Badge, Button, Txt } from '@/components/ui';
import type { DemoState } from '@/features/demo/engine';
import { retryPresentation, startPresentation, usePresentationConnection } from '@/features/demo/presentation';
import { colors, font, radius, typography } from '@/theme';

const open = (url: string) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
};

export function PresentationPanel({ s, ready }: { s: DemoState; ready: boolean }) {
  const c = usePresentationConnection();
  const linked = !!c.sessionId;
  const problem = c.status === 'error' || c.status === 'retrying';
  const complete = s.incident?.status === 'resolved' || s.incident?.status === 'rider_ok' || (s.clipDone && !s.incident);
  const noResponseNeeded = s.clipDone && !s.incident || s.incident?.status === 'rider_ok';
  const missed = !s.incident && s.log.some((e) => e.actor === 'sensor' && (e.text.includes('판정하지 못했어요') || e.text.includes('판정 불가')));
  const step = !linked ? 0 : !s.incident ? s.clipDone ? 5 : 1 : s.incident.status === 'confirming' ? 2 : s.incident.status === 'escalated' ? 3 : s.incident.status === 'acknowledged' ? 4 : 5;
  const status = c.status === 'connecting' ? '발표 서버 연결 중' : problem ? '수신 확인 필요' : !linked ? '발표 준비' : c.pending ? `전송 중 · ${c.pending}개 대기` : '서버 수신 확인';
  return (
    <View style={styles.panel}>
      <View style={styles.top}>
        <View style={styles.heading}>
          <Txt style={styles.kicker}>PRESENTATION · END TO END</Txt>
          <Txt style={styles.title}>{missed ? '데이터 부족 · 사건 구간을 판정하지 못했어요' : linked ? complete && !s.playing ? '시연 결과를 보고서에서 확인하세요' : '한 사건으로 이어지는 전체 흐름' : '재생부터 대응 결과까지, 한 번에'}</Txt>
          <Txt style={styles.description}>{linked ? '이 창을 열어 두면 라이더·관제 조작이 서버에 전달되고 운영 모니터에 반영돼요.' : '전체 흐름을 누르면 서버 연결 후 처음부터 재생해요. 본인 확인 대기부터 연락·주문 처리·보고서까지 자동 진행합니다.'}</Txt>
        </View>
        <Badge tone={problem ? 'red' : linked ? 'green' : 'neutral'}>{status}</Badge>
      </View>
      <View style={styles.steps}>
        {['데이터 수신', '사고 판정', '라이더 확인', '연락·신고', '주문 처리', '보고서'].map((label, i) => (
          <View key={label} style={[styles.step, linked && i <= step && !(noResponseNeeded && i > 1 && i < 5) && styles.stepDone, linked && i === step && styles.stepCurrent]}>
            <Txt style={[styles.stepNumber, linked && i <= step && !(noResponseNeeded && i > 1 && i < 5) && styles.stepNumberDone]}>{`${String(i + 1).padStart(2, '0')}`}</Txt>
            <Txt style={styles.stepLabel}>{noResponseNeeded && i > 1 && i < 5 ? `${label} · 생략` : label}</Txt>
          </View>
        ))}
      </View>
      <View style={styles.actions}>
        <Button label={linked ? '전체 흐름 다시 시연' : '전체 흐름 자동 시연'} variant="primary" size="sm" disabled={!ready || c.status === 'connecting'} loading={c.status === 'connecting'} onPress={() => void startPresentation(true)} />
        {!linked ? <Button label="수동 시연 연결" variant="outline" size="sm" disabled={!ready || c.status === 'connecting'} onPress={() => void startPresentation(false)} /> : null}
        <Button label={linked ? '수신 중인 운영 모니터 ↗' : '운영 모니터 · 데이터 선택 ↗'} variant="outline" size="sm" onPress={() => open(c.monitorUrl ?? `${API_URL}/ops/presentation`)} />
        {linked && complete ? <Button label="수신 결과·보고서 ↗" variant="soft" size="sm" onPress={() => open(c.monitorUrl!)} /> : null}
        {c.status === 'retrying' ? <Button label="수신 다시 확인" variant="outline" size="sm" onPress={retryPresentation} /> : null}
      </View>
      {problem ? <Txt accessibilityRole="alert" style={styles.error}>{c.message}{c.status === 'retrying' ? ' 재생을 잠시 멈췄어요. 수신 확인 후 ‘이어서 재생’을 눌러 주세요.' : ''}</Txt> : null}
      <View style={styles.footer}>
        <Txt style={styles.note}>실측 파형 · 대응은 시연 처리 · 문자·119·외부 배차 실제 발송 없음</Txt>
        {c.receivedAt ? <Txt style={styles.receipt}>{`수신 ${new Date(c.receivedAt).toLocaleTimeString('ko-KR', { hour12: false })} · 처리 ${c.acknowledged}건`}</Txt> : null}
        {linked ? <Pressable accessibilityRole="link" onPress={() => open(c.monitorUrl!)}><Txt style={styles.link}>다른 기기에서도 모니터 링크로 조회할 수 있어요 ↗</Txt></Pressable> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 20, gap: 16, borderWidth: 1, borderColor: colors.border },
  top: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start', justifyContent: 'space-between' },
  heading: { flex: 1, minWidth: 250, gap: 5 },
  kicker: { ...font.mono(600), fontSize: 10, letterSpacing: 1.7, color: colors.textMuted },
  title: { ...font.sans(800), fontSize: 23, lineHeight: 32, letterSpacing: -0.6, color: colors.text },
  description: { ...typography.caption, maxWidth: 780 },
  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  step: { flex: 1, minWidth: 120, padding: 12, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.surfaceMuted, flexDirection: 'row', gap: 10, alignItems: 'center' },
  stepDone: { backgroundColor: colors.greenSoft, borderColor: colors.greenSoft },
  stepCurrent: { borderColor: colors.green },
  stepNumber: { ...font.mono(700), fontSize: 12, color: colors.textMuted },
  stepNumberDone: { color: colors.green },
  stepLabel: { ...font.sans(700), fontSize: 13, color: colors.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  note: { ...typography.meta, flexGrow: 1 },
  receipt: { ...font.mono(500), fontSize: 11, color: colors.textMuted },
  link: { ...typography.meta, textDecorationLine: 'underline' },
  error: { ...typography.caption, color: colors.redInk },
});
