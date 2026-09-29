import { View } from 'react-native';

import { LogoIcon } from '@/components/Icons';
import { Screen, Txt } from '@/components/ui';
import { colors, font, typography } from '@/theme';

/**
 * 자리 화면 — 비상연락처가 받는 긴급 알림 웹(v3·9) 미리보기. 흰 바탕 전체 화면, 머리글 없음.
 * 화면 담당이 v3·9 디자인대로 채운다 (지도는 components/RiderMap tone="red").
 */
export default function EmergencyScreen() {
  return (
    <Screen tone="white">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center' }}>
        <LogoIcon size={24} check={false} />
        <Txt style={[font.sans(700), { fontSize: 15, color: colors.text }]}>Rider Guard 긴급 알림</Txt>
      </View>
      <Txt style={[typography.title, { textAlign: 'center' }]}>긴급 알림</Txt>
    </Screen>
  );
}
