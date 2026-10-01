import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, Txt } from '@/components/ui';
import { webAlarm, type AlarmState } from '@/features/web-alarm';
import { colors, typography } from '@/theme';

const labels: Record<AlarmState, string> = {
  off: '경고음 준비 전', preparing: '브라우저 소리 확인 중', ready: '브라우저 경고음 준비됨', playing: '경고음 재생 중',
  blocked: '브라우저에서 소리 재생을 확인하지 못했어요', unavailable: '이 브라우저는 경고음 재생을 지원하지 않아요',
};

export function AlarmSoundControl({ active = false, onDark = false }: { active?: boolean; onDark?: boolean }) {
  const state = useSyncExternalStore(webAlarm.subscribe, webAlarm.getState, () => 'off' as const);
  const activeRef = useRef(active);
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    activeRef.current = active;
    if (Platform.OS !== 'web') return;
    if (active) webAlarm.start(); else webAlarm.stop();
    return () => { focused.current = false; webAlarm.stop(); };
  }, [active]));
  if (Platform.OS !== 'web') return null;
  const prepare = async () => {
    const ready = await webAlarm.prepare(!activeRef.current);
    if (ready && focused.current && activeRef.current) webAlarm.start();
  };
  if (onDark) return (
    <View style={[styles.wrap, styles.row]}>
      <Txt style={[styles.note, styles.light, styles.grow]} accessibilityLiveRegion="polite">{labels[state]}</Txt>
      {state === 'playing' ? <Button label="소리 끄기" size="sm" variant="white" onPress={() => webAlarm.disable()} />
        : <Button label="경고음 켜기" size="sm" variant="white" disabled={state === 'preparing' || state === 'unavailable'} onPress={() => void prepare()} />}
    </View>
  );
  return (
    <View style={styles.wrap}>
      <Txt style={[styles.text, onDark && styles.light]} accessibilityLiveRegion="polite">{labels[state]}</Txt>
      <View style={styles.row}>
        <Button label={active ? '경고음 켜기' : '경고음 준비·시험'} size="sm" variant={onDark ? 'white' : 'outline'} disabled={state === 'preparing' || state === 'unavailable'} onPress={() => void prepare()} />
        {state === 'playing' || state === 'ready' ? <Button label="소리 끄기" size="sm" variant={onDark ? 'white' : 'soft'} onPress={() => webAlarm.disable()} /> : null}
      </View>
      <Txt style={[styles.note, onDark && styles.light]}>기기 음량을 확인하세요. 화면 잠금·다른 앱 사용 중에는 소리와 감지가 제한될 수 있어요.</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 14, marginBottom: 8 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  grow: { flex: 1, minWidth: 150 },
  text: { ...typography.caption }, note: { ...typography.meta }, light: { color: colors.textOnDark },
});
