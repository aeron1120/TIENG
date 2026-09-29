/**
 * 토스트 — '연락처를 저장했어요' 같은 짧은 확인. 화면 아래(탭바 위)에 잠깐 떴다 사라진다.
 * _layout 이 Stack 바깥에 ToastProvider 를 두므로, 화면을 떠나기 직전에 show 해도 토스트는 살아 있다.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckIcon, InfoIcon, WarningTriangleIcon } from '@/components/Icons';
import { Txt, useReducedMotion } from '@/components/ui';
import { colors, font, motion, radius, shadow } from '@/theme';

/** success = 끝났어요(체크) · info = 알려 드려요(i) · error = 안 됐어요(느낌표) */
export type ToastTone = 'success' | 'info' | 'error';

export type ToastApi = {
  /** 새 show 는 떠 있던 것을 바로 대체한다. tone 기본 success */
  show: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
};

const noop = () => {};
const ToastContext = createContext<ToastApi>({ show: noop, success: noop, info: noop, error: noop });

/** 토스트 띄우기: const toast = useToast(); toast.show('연락처를 저장했어요') / toast.info('문자를 다시 보냈어요') */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const HOLD_MS = 1800;
let toastSeq = 0;

type ToastItem = { id: number; message: string; tone: ToastTone };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    toastSeq += 1;
    setToast({ id: toastSeq, message, tone });
    AccessibilityInfo.announceForAccessibility(message);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({ show, success: (m) => show(m, 'success'), info: (m) => show(m, 'info'), error: (m) => show(m, 'error') }),
    [show],
  );
  const dismiss = useCallback((id: number) => setToast((t) => (t?.id === id ? null : t)), []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast && <ToastHost key={toast.id} item={toast} onDone={dismiss} />}
    </ToastContext.Provider>
  );
}

/** v3: 아스팔트 바탕 흰 글자. 끝났어요는 초록 체크, 안내는 흰 i, 안 됐어요는 흰 경고 삼각형(평소 화면이라 빨강을 쓰지 않는다) */
const TONE_ICON = {
  success: { Icon: CheckIcon, color: colors.greenOnDark },
  info: { Icon: InfoIcon, color: colors.textOnDark },
  error: { Icon: WarningTriangleIcon, color: colors.textOnDark },
} as const;

function ToastHost({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  const { id, message, tone } = item;
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(reduced ? 0 : 24));

  useEffect(() => {
    const d = reduced ? 0 : 1;
    const anim = Animated.sequence([
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, speed: 18, bounciness: 6, useNativeDriver: motion.native }),
        Animated.timing(opacity, { toValue: 1, duration: 200 * d, easing: motion.easeOut, useNativeDriver: motion.native }),
      ]),
      Animated.delay(tone === 'error' ? HOLD_MS + 800 : HOLD_MS),
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 180 * d, easing: motion.easeOut, useNativeDriver: motion.native }),
        Animated.timing(translateY, { toValue: 8 * d, duration: 180 * d, easing: motion.easeOut, useNativeDriver: motion.native }),
      ]),
    ]);
    anim.start(({ finished }) => {
      if (finished) onDone(id);
    });
    return () => anim.stop();
  }, [id, tone, onDone, opacity, translateY, reduced]);

  const { Icon, color } = TONE_ICON[tone];
  return (
    <Animated.View
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={[styles.toast, { bottom: insets.bottom + 96, opacity, transform: [{ translateY }] }]}
    >
      <View style={styles.icon}>
        <Icon size={20} color={color} strokeWidth={2.4} />
      </View>
      <Txt style={styles.text}>{message}</Txt>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.xl,
    backgroundColor: colors.asphalt,
    boxShadow: shadow.raised,
    pointerEvents: 'none',
  },
  icon: { width: 20, height: 20 },
  text: { ...font.sans(600), flex: 1, fontSize: 15, lineHeight: 21, color: colors.textOnDark },
});
