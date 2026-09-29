import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContactsIcon, HomeIcon, RecordsIcon, SettingsIcon } from '@/components/Icons';
import { Txt } from '@/components/ui';
import { colors, font } from '@/theme';

type TabKey = 'home' | 'records' | 'contacts' | 'settings';

/**
 * 디자인 링크 구조: 홈 → Home, 기록 → Records, 연락망 → Setup, 설정 → Settings(디자인 없음).
 * 홈/기록/설정은 서로 교체(replace)하고, 연락망은 Setup 을 위에 쌓아 뒤로가기로 돌아올 수 있게 한다.
 */
const TABS: { key: TabKey; label: string; Icon: typeof HomeIcon; go?: () => void }[] = [
  { key: 'home', label: '홈', Icon: HomeIcon, go: () => router.replace('/home') },
  { key: 'records', label: '기록', Icon: RecordsIcon, go: () => router.replace('/records') },
  { key: 'contacts', label: '연락망', Icon: ContactsIcon, go: () => router.push('/setup') },
  { key: 'settings', label: '설정', Icon: SettingsIcon, go: () => router.replace('/settings') },
];

export function BottomNav({ active }: { active: TabKey }) {
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" accessibilityLabel="하단 메뉴" style={[styles.nav, { paddingBottom: Math.max(insets.bottom, 22) }]}>
      {TABS.map(({ key, label, Icon, go }) => {
        const selected = key === active;
        const color = selected ? colors.accent : colors.textMuted;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled: !go }}
            onPress={selected ? undefined : go}
            style={({ pressed }) => [styles.tab, pressed && !selected && go && { opacity: 0.6 }]}
          >
            <Icon size={22} color={color} />
            <Txt style={[styles.label, font.sans(selected ? 700 : 600), { color }]}>{label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: {
    flexDirection: 'row',
    paddingTop: 6,
    paddingHorizontal: 8,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  tab: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 3 },
  label: { fontSize: 12 },
});
