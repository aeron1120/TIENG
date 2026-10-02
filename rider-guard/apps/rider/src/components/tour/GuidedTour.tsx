import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewProps, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Txt, useReducedMotion } from '@/components/ui';
import { colors, font, radius, shadow } from '@/theme';
import { clamp, interpolateRect, nextAvailableStep, scrollDestination, tourCardMaxHeight, tourLayout, type Rect } from './geometry';
import { lockWebInput, measureTarget } from './platform';
import { canAdvanceTourStep, type TourStep } from './steps';

type TargetAction = { press: () => void | Promise<void>; enabled: () => boolean };
type Target = { node: View; fixed: boolean; action?: TargetAction };
export type TourScrollProps = Pick<ScrollViewProps, 'scrollEnabled' | 'onScroll' | 'onContentSizeChange' | 'scrollEventThrottle'> & { ref: React.RefObject<ScrollView | null> };
type TourContextValue = {
  active: boolean;
  stepTarget: string | null;
  start: () => void;
  register: (name: string, node: View | null, fixed: boolean, action?: TargetAction) => void;
  scrollProps: TourScrollProps;
};
const TourContext = createContext<TourContextValue | null>(null);
export function useGuidedTour() {
  const tour = useContext(TourContext);
  if (!tour) throw new Error('useGuidedTour requires GuidedTourProvider');
  return tour;
}

export function TourTarget({ name, fixed = false, onTourPress, tourDisabled = false, ...props }: ViewProps & { name: string; fixed?: boolean; onTourPress?: () => void | Promise<void>; tourDisabled?: boolean }) {
  const register = useContext(TourContext)?.register;
  const interaction = useRef({ onTourPress, tourDisabled });
  useLayoutEffect(() => { interaction.current = { onTourPress, tourDisabled }; }, [onTourPress, tourDisabled]);
  const ref = useCallback((node: View | null) => register?.(name, node, fixed, {
    press: () => interaction.current.onTourPress?.(),
    enabled: () => !!interaction.current.onTourPress && !interaction.current.tourDisabled,
  }), [register, name, fixed]);
  return <View {...props} ref={ref} collapsable={false} nativeID={`tour-${name}`} />;
}

/** The spotlight invokes exactly the same handler as the visible button, on web and native. */
export function TourActionButton({ name, onPress, onTourPress, ...props }: Omit<ComponentProps<typeof Button>, 'onPress'> & { name: string; onPress: () => void | Promise<void>; onTourPress?: () => void | Promise<void> }) {
  return <TourTarget name={name} onTourPress={onTourPress ?? onPress} tourDisabled={props.disabled || props.loading} style={props.style}>
    <Button {...props} onPress={onPress} style={undefined} />
  </TourTarget>;
}

export function TourHelpButton({ name, disabled = false }: { name: string; disabled?: boolean }) {
  const { start } = useGuidedTour();
  return <TourTarget name={name}>
    <Pressable onPress={start} disabled={disabled} accessibilityRole="button" accessibilityLabel="도움말 · 화면 가이드 시작" accessibilityState={{ disabled }} style={({ pressed }) => [styles.help, pressed && styles.pressed, disabled && styles.disabled]}>
      <View style={styles.helpIcon}><Txt style={styles.question}>?</Txt></View><Txt style={styles.helpText}>도움말</Txt>
    </Pressable>
  </TourTarget>;
}

export function GuidedTourProvider({ children, steps, onStart, onClose }: { children: ReactNode; steps: TourStep[]; onStart?: () => void; onClose?: () => void }) {
  const targets = useRef(new Map<string, Target>());
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const contentHeight = useRef(0);
  const savedY = useRef(0);
  const request = useRef(0);
  const starting = useRef(false);
  const lifecycle = useRef({ onStart, onClose });
  const stepsRef = useRef(steps);
  useLayoutEffect(() => { lifecycle.current = { onStart, onClose }; stepsRef.current = steps; }, [onStart, onClose, steps]);
  const [index, setIndex] = useState<number | null>(null);
  const currentIndex = useRef<number | null>(null);
  const [available, setAvailable] = useState<boolean[]>([]);
  const activeRef = useRef(false);
  const close = useCallback(() => {
    request.current++;
    starting.current = false;
    if (activeRef.current) {
      scrollRef.current?.scrollTo({ y: savedY.current, animated: false });
      lifecycle.current.onClose?.();
    }
    activeRef.current = false;
    currentIndex.current = null;
    setIndex(null);
  }, []);
  useFocusEffect(useCallback(() => () => close(), [close]));
  const register = useCallback((name: string, node: View | null, fixed: boolean, action?: TargetAction) => {
    if (node) targets.current.set(name, { node, fixed, action });
    else targets.current.delete(name);
  }, []);
  const resolveTarget = useCallback((step: TourStep) => targets.current.get(step.target) ?? targets.current.get(step.fallbackTarget ?? ''), []);
  const inspect = useCallback(async () => Promise.all(stepsRef.current.map(async (step) => !!step.interaction || !!await measureTarget(resolveTarget(step)?.node ?? null))), [resolveTarget]);
  const start = useCallback(() => {
    if (activeRef.current || starting.current) return;
    starting.current = true;
    const generation = ++request.current;
    void inspect().then((visible) => {
      if (generation !== request.current) return;
      starting.current = false;
      const first = nextAvailableStep(-1, 1, visible);
      if (first < 0) return;
      savedY.current = scrollY.current;
      activeRef.current = true;
      lifecycle.current.onStart?.();
      setAvailable(visible);
      currentIndex.current = first;
      setIndex(first);
    });
  }, [inspect]);
  const navigate = useCallback((direction: 1 | -1) => {
    if (currentIndex.current === null || (direction === 1 && !canAdvanceTourStep(stepsRef.current[currentIndex.current]))) return;
    const generation = ++request.current;
    void inspect().then((visible) => {
      if (generation !== request.current || !activeRef.current) return;
      setAvailable(visible);
      if (currentIndex.current === null) return;
      const next = nextAvailableStep(currentIndex.current, direction, visible);
      if (next < 0) { if (direction === 1) close(); return; }
      currentIndex.current = next;
      setIndex(next);
    });
  }, [inspect, close]);
  const completion = index === null ? undefined : steps[index]?.complete;
  const lastCompletion = useRef<{ index: number | null; complete?: boolean }>({ index: null });
  useEffect(() => {
    const before = lastCompletion.current;
    lastCompletion.current = { index, complete: completion };
    // Going back to an already completed action stays there until Next is pressed.
    if (index !== null && before.index === index && !before.complete && completion) {
      const timer = setTimeout(() => navigate(1), 600);
      return () => clearTimeout(timer);
    }
  }, [index, completion, navigate]);
  const active = index !== null;
  const stepTarget = index === null ? null : steps[index].target;
  const value = useMemo<TourContextValue>(() => ({
    active, stepTarget, start, register,
    scrollProps: {
      ref: scrollRef, scrollEnabled: !active, scrollEventThrottle: 16,
      onScroll: (event) => { scrollY.current = event.nativeEvent.contentOffset.y; },
      onContentSizeChange: (_width, height) => { contentHeight.current = height; },
    },
  }), [active, stepTarget, start, register]);

  return <TourContext.Provider value={value}>
    {children}
    {index !== null ? <TourOverlay
      step={steps[index]} index={available.slice(0, index + 1).filter(Boolean).length} total={available.filter(Boolean).length}
      target={() => resolveTarget(steps[index])} scrollRef={scrollRef} scrollY={scrollY} contentHeight={contentHeight}
      active={activeRef}
      close={close} next={() => navigate(1)} previous={() => navigate(-1)}
    /> : null}
  </TourContext.Provider>;
}

type OverlayProps = {
  step: TourStep; index: number; total: number; target: () => Target | undefined;
  scrollRef: React.RefObject<ScrollView | null>; scrollY: React.RefObject<number>; contentHeight: React.RefObject<number>;
  active: React.RefObject<boolean>;
  close: () => void; next: () => void; previous: () => void;
};
function TourOverlay({ step, index, total, target, scrollRef, scrollY, contentHeight, active, close, next, previous }: OverlayProps) {
  const windowSize = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [viewport, setViewport] = useState({ width: windowSize.width, height: windowSize.height });
  const [cardSize, setCardSize] = useState({ width: 350, height: 260 });
  const [frame, setFrame] = useState<{ hole: Rect; card: Rect } | null>(null);
  const [settled, setSettled] = useState<{ name: string; node: View; enabled: boolean } | null>(null);
  const [measuredAction, setMeasuredAction] = useState<{ target: string; height: number } | null>(null);
  const [pressing, setPressing] = useState(false);
  const pressLock = useRef(false);
  const [actionError, setActionError] = useState<{ target: string; message: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentFrame = useRef(frame);
  const cardRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);
  const actions = useRef({ close, next, previous });
  const targetRef = useRef(target);
  useLayoutEffect(() => { actions.current = { close, next, previous }; targetRef.current = target; }, [close, next, previous, target]);
  const safe = useMemo(() => ({ width: viewport.width, height: Math.max(1, viewport.height - insets.top - insets.bottom) }), [viewport, insets.top, insets.bottom]);
  const awaitingPress = step.interaction === 'press' && !step.complete;
  const maxCardHeight = tourCardMaxHeight(safe.height, awaitingPress ? measuredAction?.target === step.target ? measuredAction.height : 64 : undefined);

  useEffect(() => {
    if (!overlayRef.current) return;
    return lockWebInput(overlayRef.current, {
      close: () => actions.current.close(), next: () => actions.current.next(), previous: () => actions.current.previous(),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let animation = 0;
    let observer = 0;
    const local = (rect: Rect, origin: Rect | null): Rect => ({ ...rect, x: rect.x - (origin?.x ?? 0), y: rect.y - (origin?.y ?? 0) - insets.top });
    const draw = (value: { hole: Rect; card: Rect }) => { currentFrame.current = value; setFrame(value); };
    const unavailable = () => {
      if (step.interaction) observer = window.setTimeout(() => { if (!cancelled && active.current) void move(); }, 180);
      else actions.current.next();
    };
    const move = async () => {
      const selected = targetRef.current();
      const [measured, origin, scroller] = await Promise.all([
        measureTarget(selected?.node ?? null), measureTarget(overlayRef.current), measureTarget(scrollRef.current?.getNativeScrollRef() ?? null),
      ]);
      if (cancelled || !active.current) return;
      setSettled(null);
      if (!measured) { unavailable(); return; }
      if (awaitingPress) setMeasuredAction({ target: step.target, height: measured.height });
      const rect = local(measured, origin);
      const startY = scrollY.current;
      // On narrow screens reserve the bottom for the guide; large targets align at the top.
      const sideFits = rect.x + rect.width + cardSize.width + 28 <= safe.width || rect.x >= cardSize.width + 28;
      const desiredY = Math.max(12, (scroller?.y ?? 0) - (origin?.y ?? 0) - insets.top + 12);
      const fullyVisible = rect.y >= desiredY && rect.y + rect.height <= safe.height - (sideFits ? 12 : cardSize.height + 32);
      const endY = selected?.fixed || !scroller || fullyVisible ? startY : scrollDestination(rect.y, startY, desiredY, contentHeight.current - scroller.height);
      const initial = currentFrame.current;
      const duration = reduced ? 0 : clamp(350 + Math.abs(endY - startY) * 0.25, 350, 950);
      const began = performance.now();
      const tick = async (now: number) => {
        if (cancelled || !active.current) return;
        if (targetRef.current()?.node !== selected?.node) { void move(); return; }
        const progress = duration ? clamp((now - began) / duration, 0, 1) : 1;
        const eased = 1 - Math.pow(1 - progress, 3);
        if (endY !== startY) scrollRef.current?.scrollTo({ y: startY + (endY - startY) * eased, animated: false });
        const live = await measureTarget(selected?.node ?? null);
        if (cancelled || !active.current) return;
        if (!live) { unavailable(); return; }
        const goal = tourLayout(local(live, origin), safe, cardSize, awaitingPress);
        draw(initial && progress < 1 ? { hole: interpolateRect(initial.hole, goal.hole, eased), card: interpolateRect(initial.card, goal.card, eased) } : goal);
        if (progress < 1) animation = requestAnimationFrame((time) => { void tick(time); });
        else { if (selected) setSettled({ name: step.target, node: selected.node, enabled: !!selected.action?.enabled() }); observe(); }
      };
      // Continue following images, font/layout changes and conditional targets after arrival.
      const observe = () => {
        observer = window.setTimeout(async () => {
          if (targetRef.current()?.node !== selected?.node) { if (!cancelled && active.current) void move(); return; }
          const live = await measureTarget(targetRef.current()?.node ?? null);
          if (cancelled || !active.current) return;
          if (!live) { unavailable(); return; }
          if (selected) setSettled({ name: step.target, node: selected.node, enabled: !!selected.action?.enabled() });
          draw(tourLayout(local(live, origin), safe, cardSize, awaitingPress));
          observe();
        }, 180);
      };
      animation = requestAnimationFrame((time) => { void tick(time); });
    };
    void move();
    return () => { cancelled = true; cancelAnimationFrame(animation); clearTimeout(observer); };
  }, [step.target, step.interaction, awaitingPress, cardSize, safe, insets.top, reduced, scrollRef, scrollY, contentHeight, active]);

  const hole = frame?.hole;
  const card = frame?.card;
  const ring = hole ? { left: hole.x, top: hole.y + insets.top, width: hole.width, height: hole.height } : null;
  const actionEnabled = awaitingPress && settled?.name === step.target && settled.enabled && !pressing;
  const pressTarget = async () => {
    const selected = targetRef.current();
    if (!actionEnabled || pressLock.current || selected?.node !== settled?.node || !selected?.action?.enabled()) return;
    pressLock.current = true;
    setPressing(true);
    setActionError(null);
    try { await selected.action.press(); }
    catch (error) { if (mounted.current) setActionError({ target: step.target, message: error instanceof Error ? error.message : '실행하지 못했어요. 다시 눌러 주세요.' }); }
    finally { pressLock.current = false; if (mounted.current) setPressing(false); }
  };
  return <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close} supportedOrientations={['portrait', 'landscape']}>
    <View ref={overlayRef} role="dialog" aria-label="화면 가이드" aria-modal style={styles.overlay} onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setViewport((old) => old.width === width && old.height === height ? old : { width, height }); }} accessibilityViewIsModal onAccessibilityEscape={close}>
      {/* Only the current action gets a hotspot above the input-blocking layer. */}
      <Pressable style={StyleSheet.absoluteFill} focusable={false} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onPress={() => {}} />
      {hole ? <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[styles.shade, { left: 0, top: 0, right: 0, height: hole.y + insets.top }]} />
        <View style={[styles.shade, { left: 0, top: hole.y + insets.top + hole.height, right: 0, bottom: 0 }]} />
        <View style={[styles.shade, { left: 0, top: hole.y + insets.top, width: hole.x, height: hole.height }]} />
        <View style={[styles.shade, { left: hole.x + hole.width, top: hole.y + insets.top, right: 0, height: hole.height }]} />
        <View nativeID="tour-spotlight" style={[styles.ring, ring]} />
      </View> : <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade]} />}
      {awaitingPress && ring ? <Pressable nativeID="tour-action" style={[styles.hotspot, ring]} onPress={() => void pressTarget()} disabled={!actionEnabled} accessibilityRole="button" accessibilityLabel={step.actionLabel ?? step.title} accessibilityHint="누르면 이 기능을 실행하고 다음 단계로 이동합니다" accessibilityState={{ disabled: !actionEnabled, busy: pressing }} /> : null}
      <View ref={cardRef} nativeID="tour-card" style={[styles.card, safe.height < 400 && styles.compactCard, { width: Math.min(350, safe.width - 24), maxHeight: maxCardHeight, left: card?.x ?? 12, top: (card?.y ?? 12) + insets.top, opacity: frame ? 1 : 0 }]} onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setCardSize((old) => Math.abs(old.width - width) < 1 && Math.abs(old.height - height) < 1 ? old : { width, height }); }}>
        <View style={styles.cardHeader}><View style={styles.tag}><View style={styles.dot} /><Txt style={styles.tagText}>{step.interaction ? '직접 해보기' : '화면 가이드'}</Txt></View><Txt style={styles.count}>{`${index} / ${total}`}</Txt></View>
        <TourProgress index={index} total={total} reduced={reduced} />
        <ScrollView nativeID="tour-card-body" style={styles.cardBody} contentContainerStyle={styles.cardBodyContent} bounces={false}>
          <View accessibilityLiveRegion="polite" accessible accessibilityLabel={`${index} / ${total}. ${step.title}. ${step.body}`}>
            <Txt accessibilityRole="header" style={styles.title}>{step.title}</Txt>
            <Txt style={styles.body}>{step.body}</Txt>
          </View>
          {step.hint ? <View style={styles.hint}><Txt style={styles.hintText}>{step.hint}</Txt></View> : null}
          {step.interaction ? <View style={styles.hint}><Txt accessibilityLiveRegion="polite" style={styles.hintText}>{step.complete ? '✓ 완료했어요. 다음 단계로 이어집니다.' : pressing ? '실행 중이에요…' : step.interaction === 'wait' ? '진행 상황을 기다리고 있어요…' : `☝ 화면의 ‘${step.actionLabel}’ 버튼을 눌러 주세요.`}</Txt></View> : null}
          {actionError?.target === step.target ? <Txt accessibilityRole="alert" style={styles.error}>{actionError.message}</Txt> : null}
        </ScrollView>
        <View style={styles.actions}>
          <TourButton label="그만 보기" onPress={close} variant="skip" />
          <View style={styles.spacer} />
          <TourButton label="이전" onPress={previous} disabled={index <= 1} />
          <TourButton label={index === total ? '마치기' : '다음'} onPress={next} variant="primary" disabled={!canAdvanceTourStep(step)} />
        </View>
        {Platform.OS === 'web' && safe.width >= 600 && safe.height >= 400 ? <Txt style={styles.keyboard}>← → 단계 이동 · Esc 닫기</Txt> : null}
      </View>
    </View>
  </Modal>;
}

function TourProgress({ index, total, reduced }: { index: number; total: number; reduced: boolean }) {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const animation = Animated.timing(progress, { toValue: total ? index / total : 0, duration: reduced ? 0 : 240, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [index, total, progress, reduced]);
  return <View accessibilityRole="progressbar" accessibilityLabel="안내 진행률" accessibilityValue={{ min: 0, max: total, now: index }} style={styles.track}>
    <Animated.View style={[styles.progress, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
  </View>;
}

function TourButton({ label, onPress, disabled = false, variant }: { label: string; onPress: () => void; disabled?: boolean; variant?: 'primary' | 'skip' }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, variant === 'primary' && styles.primary, variant === 'skip' && styles.skip, pressed && styles.pressed, disabled && styles.disabled]}>
    <Txt style={[styles.buttonText, variant === 'primary' && styles.primaryText, variant === 'skip' && styles.skipText]}>{label}</Txt>
  </Pressable>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  hotspot: { position: 'absolute', borderRadius: 10 },
  error: { ...font.sans(500), fontSize: 12, lineHeight: 18, color: colors.redInk },
  shade: { position: 'absolute', backgroundColor: colors.tourScrim },
  ring: { position: 'absolute', borderWidth: 2, borderColor: colors.surface, borderRadius: 10, boxShadow: `0 0 0 4px ${colors.accentGlowHalo}` },
  card: { position: 'absolute', backgroundColor: colors.surface, borderRadius: 20, padding: 18, boxShadow: shadow.raised, borderWidth: 1, borderColor: colors.border },
  compactCard: { padding: 12 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  tagText: { ...font.sans(700), fontSize: 11, color: colors.textMuted, letterSpacing: 0.4 },
  count: { ...font.mono(600), fontSize: 12, color: colors.textMuted },
  track: { height: 3, borderRadius: 2, overflow: 'hidden', backgroundColor: colors.curb, marginTop: 12, marginBottom: 17 },
  progress: { height: '100%', backgroundColor: colors.green, borderRadius: 2 },
  cardBody: { flexShrink: 1 },
  cardBodyContent: { gap: 12 },
  title: { ...font.sans(800), fontSize: 19, lineHeight: 27, letterSpacing: -0.6, marginBottom: 8 },
  body: { ...font.sans(400), fontSize: 14, lineHeight: 23, color: colors.textMuted },
  hint: { backgroundColor: colors.greenSoft, padding: 10, borderRadius: radius.md },
  hintText: { ...font.sans(500), fontSize: 12, lineHeight: 18, color: colors.text },
  actions: { flexDirection: 'row', gap: 7, alignItems: 'center', marginTop: 16 },
  spacer: { flex: 1 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 10, backgroundColor: colors.surfaceMuted },
  buttonText: { ...font.sans(700), fontSize: 13 },
  primary: { backgroundColor: colors.asphalt },
  primaryText: { color: colors.textOnDark },
  skip: { backgroundColor: 'transparent', paddingHorizontal: 0 },
  skipText: { color: colors.textMuted },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.72 },
  keyboard: { ...font.sans(400), fontSize: 10, color: colors.textFaint, textAlign: 'right', marginTop: 10 },
  help: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  helpIcon: { width: 17, height: 17, borderRadius: 9, borderWidth: 1.5, borderColor: colors.textMuted, alignItems: 'center', justifyContent: 'center' },
  question: { ...font.sans(700), fontSize: 11, lineHeight: 14, color: colors.textMuted },
  helpText: { ...font.sans(600), fontSize: 12, color: colors.text },
});
