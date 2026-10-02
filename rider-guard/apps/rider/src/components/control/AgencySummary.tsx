import type { AgencyBoardDto } from '@rider-guard/contract';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { useToast } from '@/components/Toast';
import { TourTarget } from '@/components/tour/GuidedTour';
import { Txt } from '@/components/ui';
import type { DemoState } from '@/features/demo/engine';
import { colors, font, radius, typography } from '@/theme';

export function AgencySummary({ board, snapshot }: { board: AgencyBoardDto; snapshot: DemoState | null }) {
  const toast = useToast();
  const agency = board.agency!;
  const open = snapshot ? Number(!!snapshot.incident && !['resolved', 'rider_ok'].includes(snapshot.incident.status))
    : board.incidents.filter((incident) => ['countdown', 'escalated'].includes(incident.status)).length;
  const copy = (code: string, label: string) => {
    if (Platform.OS === 'web' && navigator.clipboard) {
      void navigator.clipboard.writeText(code).then(() => toast.success(`${label}를 복사했어요`)).catch(() => toast.error('복사하지 못했어요. 코드를 직접 선택해 주세요.'));
    }
  };
  return <TourTarget name="control-agency" style={styles.strip}>
    <View style={styles.flex}><Txt style={styles.name}>{agency.name}</Txt><Txt style={styles.caption}>라이더 앱 → 소속 배달대행사 → 가입 코드로 연결해요</Txt></View>
    <Pressable onPress={() => copy(agency.joinCode, '라이더 가입 코드')} accessibilityRole="button" accessibilityLabel={`라이더 가입 코드 ${agency.joinCode}, 복사`} style={styles.codeBox}>
      <Txt style={styles.codeLabel}>라이더 가입 코드</Txt><Txt selectable style={styles.code}>{agency.joinCode}</Txt>
    </Pressable>
    <Pressable onPress={() => copy(agency.staffCode, '관제사 초대 코드')} accessibilityRole="button" accessibilityLabel={`관제사 초대 코드 ${agency.staffCode}, 복사`} style={styles.staffBox}>
      <Txt style={styles.staffLabel}>관제사 초대 코드 · 라이더에게 주지 마세요</Txt><Txt selectable style={styles.staffCode}>{agency.staffCode}</Txt>
    </Pressable>
    <Stat n={snapshot?.riders.length ?? board.riders.length} label="소속" />
    <Stat n={snapshot ? snapshot.riders.filter((rider) => rider.base !== 'off').length : board.riders.filter((rider) => rider.protecting).length} label="보호 중" />
    <Stat n={snapshot ? snapshot.orders.filter((order) => ['delivering', 'reassigned'].includes(order.status)).length : board.orders.filter((order) => ['assigned', 'reassigned'].includes(order.status)).length} label="진행 주문" />
    <Stat n={open} label="사고" alert={open > 0} />
  </TourTarget>;
}

function Stat({ n, label, alert = false }: { n: number; label: string; alert?: boolean }) {
  return <View style={styles.stat}><Txt style={[styles.number, alert && { color: colors.red }]}>{String(n)}</Txt><Txt style={typography.meta}>{label}</Txt></View>;
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, backgroundColor: colors.surface, borderRadius: radius.card, padding: 16 },
  flex: { flex: 1, minWidth: 220, gap: 4 },
  name: { ...font.sans(800), fontSize: 20, color: colors.text },
  caption: { ...typography.caption },
  codeBox: { backgroundColor: colors.asphalt, borderRadius: radius.lg, paddingVertical: 8, paddingHorizontal: 14, alignItems: 'center' },
  codeLabel: { ...font.sans(600), fontSize: 11, color: colors.textOnDark, opacity: 0.7 },
  code: { ...font.mono(700), fontSize: 22, letterSpacing: 4, color: colors.textOnDark },
  staffBox: { borderRadius: radius.lg, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center', borderWidth: 1.5, borderColor: colors.border },
  staffLabel: { ...font.sans(600), fontSize: 11, color: colors.textMuted },
  staffCode: { ...font.mono(700), fontSize: 16, letterSpacing: 2, color: colors.text },
  stat: { minWidth: 66, alignItems: 'center' },
  number: { ...font.mono(700), fontSize: 24, color: colors.text },
});
