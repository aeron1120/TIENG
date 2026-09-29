import { Screen, Txt } from '@/components/ui';
import { dayLabel, timeHM } from '@/lib/format';
import { colors, font } from '@/theme';

/**
 * 자리 화면 — 잠금화면 상시 알림(v3·6) 미리보기. 어두운 전체 화면(StatusBar light).
 * 화면 담당이 v3·6 디자인대로 채운다 (그라데이션 colors.lockTop → lockBottom).
 */
export default function LockscreenScreen() {
  return (
    <Screen tone="lock">
      <Txt style={[font.sans(600), { fontSize: 17, color: colors.textOnDark, textAlign: 'center' }]}>{dayLabel()}</Txt>
      <Txt style={[font.mono(700), { fontSize: 72, lineHeight: 84, color: colors.textOnDark, textAlign: 'center' }]}>{timeHM()}</Txt>
    </Screen>
  );
}
