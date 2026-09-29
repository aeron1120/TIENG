import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DocIcon, GearIcon, ShieldIcon, type IconComponent } from '@/components/Icons';
import { Txt, usePressScale, useReducedMotion } from '@/components/ui';
import { colors, font, motion } from '@/theme';

export type TabKey = 'home' | 'records' | 'settings';

/**
 * v3·5 하단 탭: 보호(홈) · 기록 · 설정 — 흰 바탕, 위 구분선, 활성 아스팔트 · 비활성 회색.
 * 비상연락처는 홈의 '비상연락처' 카드와 설정에서 연다.
 * 탭끼리는 교체(replace)한다 — 뒤로가기로 탭 사이를 오가지 않게.
 */
const TABS: { key: TabKey; label: string; Icon: IconComponent; go: () => void }[] = [
  { key: 'home', label: '보호', Icon: ShieldIcon, go: () => router.replace('/home') },
  { key: 'records', label: '기록', Icon: DocIcon, go: () => router.replace('/records') },
  { key: 'settings', label: '설정', Icon: GearIcon, go: () => router.replace('/settings') },
];

export function BottomNav({ active }: { active: TabKey }) {
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" accessibilityLabel="하단 메뉴" style={[styles.nav, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {TABS.map(({ key, label, Icon, go }) => (
        <Tab key={key} label={label} Icon={Icon} go={go} selected={key === active} />
      ))}
    </View>
  );
}

function Tab({ label, Icon, go, selected }: { label: string; Icon: IconComponent; go: () => void; selected: boolean }) {
  const press = usePressScale(0.9);
  const color = selected ? colors.asphalt : colors.textFaint;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`${label} 탭`}
      accessibilityState={{ selected }}
      onPress={selected ? undefined : go}
      onPressIn={selected ? undefined : press.onPressIn}
      onPressOut={selected ? undefined : press.onPressOut}
      style={styles.tab}
    >
      <Animated.View style={[styles.iconSlot, { transform: [{ scale: press.scale }] }]}>
        {selected ? <SelectedIcon Icon={Icon} /> : <Icon size={22} color={color} strokeWidth={1.8} />}
      </Animated.View>
      {/* 굵기는 고정하고 색만 바꿔 글자 폭이 흔들리지 않게 */}
      <Txt style={[styles.label, { color }]}>{label}</Txt>
    </Pressable>
  );
}

/** 선택된 탭 아이콘 — 탭 화면마다 새로 그려지므로 이동할 때마다 아이콘이 살짝 튀어 오른다 */
function SelectedIcon({ Icon }: { Icon: IconComponent }) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.spring(progress, { toValue: 1, speed: 18, bounciness: 8, useNativeDriver: motion.native });
    anim.start();
    return () => anim.stop();
  }, [progress, reduced]);
  const scale = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] }), [progress]);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Icon size={22} color={colors.asphalt} strokeWidth={1.8} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  nav: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.navLine,
  },
  tab: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 4 },
  iconSlot: { width: 44, height: 24, alignItems: 'center', justifyContent: 'center' },
  label: { ...font.sans(600), fontSize: 12, lineHeight: 16 },
});
