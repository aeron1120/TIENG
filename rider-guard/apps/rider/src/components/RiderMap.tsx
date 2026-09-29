/**
 * 지도 카드 안의 실제 지도 (v3·5 홈 · v3·9 긴급 알림 웹).
 *
 *   아래층  불러오는 동안은 무늬 없는 블록색 + 옅은 스켈레톤 숨쉬기(실제 위치와 무관한 가짜 거리를 보이지 않게).
 *           오프라인·타일 실패·웹뷰 오류일 때만 MapIllustration(가상 거리 지도).
 *   가운데  MapCanvas('use dom') — MapLibre + OpenFreeMap. 웹은 DOM 그대로, 안드로이드는 react-native-webview 안.
 *           준비되면 페이드인. 조작 없는 미리보기.
 *   위층    핀 · 정확도 원 · 말풍선(MapCenterMarker) · 알약(topLeft/bottomLeft/topRight · children) · '© OpenStreetMap'
 *
 * 위치가 없으면 서울 기본 좌표(시뮬레이션)를 가운데에 둔다 — features/location 의 useRiderPosition() 을 넘기면 된다.
 */
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Animated, Platform, StyleSheet, TurboModuleRegistry, UIManager, View, type StyleProp, type ViewStyle } from 'react-native';

import { MapCenterMarker, MapIllustration, type MapPinTone, type MapVariant } from '@/components/MapIllustration';
import type { MapCanvasPalette, MapCanvasStatus } from '@/components/map/MapCanvas';
import { Skeleton, Txt, useReducedMotion } from '@/components/ui';
import { SIM } from '@/features/sim';
import { colors, font, motion, radius, shadow } from '@/theme';

const MapCanvas = lazy(() => import('@/components/map/MapCanvas'));

/** 키 없는 무료 벡터 타일 스타일 (OpenStreetMap 데이터, ODbL — 출처 표시를 남긴다) */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const DEFAULT_ZOOM = 15.6;

/** v3 디자인 지도 색 (theme 토큰에서) */
const PALETTE: MapCanvasPalette = {
  block: colors.mapBlock,
  gap: colors.mapGap,
  road: colors.mapRoad,
  roadCasing: colors.mapRoadCasing,
  building: colors.mapBuilding,
  buildingLine: colors.mapBuildingLine,
  park: colors.mapPark,
  water: colors.mapRiver,
  label: colors.mapLabel,
  labelHalo: colors.mapGap,
  rail: colors.mapRail,
};

/** 이 기기에서 실제 지도를 띄울 수 있는가 — 웹은 WebGL, 네이티브는 웹뷰 모듈이 들어 있는 빌드인지 */
function realMapSupported(): boolean {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined') return false;
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
      return false;
    }
  }
  try {
    return !!TurboModuleRegistry.get('RNCWebViewModule') || !!UIManager.hasViewManagerConfig?.('RNCWebView');
  } catch {
    return false;
  }
}

let supportCache: boolean | null = null;
const canUseRealMap = () => (supportCache ??= realMapSupported());

/** 지도 컴포넌트가 던지면 가상 지도로 */
class MapBoundary extends Component<{ onError: () => void; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ── 지도 위 알약 ──────────────────────────────────────────────

type MapPillProps = {
  label: string;
  /** 앞 아이콘 (예: <LockIcon size={16} color={colors.text} />) */
  icon?: React.ReactNode;
  /** 앞 점 색 (예: colors.green — '● 보호 중') */
  dot?: string;
  /** 점 둘레 옅은 원 색 (예: colors.greenSoft) */
  halo?: string;
  style?: StyleProp<ViewStyle>;
};

/** 지도 위 흰 알약 (v3·5 '● 보호 중' · '🔒 사고 때만 비상연락처에 전달돼요') — 높이 26, 12 SemiBold */
export function MapPill({ label, icon, dot, halo, style }: MapPillProps) {
  return (
    <View style={[styles.pill, !dot && icon ? styles.pillWithIcon : null, style]}>
      {dot ? (
        <View style={[styles.pillHalo, { backgroundColor: halo ?? 'transparent' }]}>
          <View style={[styles.pillDot, { backgroundColor: dot }]} />
        </View>
      ) : (
        icon
      )}
      <Txt numberOfLines={1} style={styles.pillText}>
        {label}
      </Txt>
    </View>
  );
}

// ── 지도 ──────────────────────────────────────────────────────

export type RiderMapProps = {
  /** 핀 색 — dark(아스팔트, 홈) · red(빨강, 긴급 알림 웹) */
  tone?: 'dark' | 'red';
  /** 핀 말풍선 ('지금 여기' · '21:42 마지막 위치'). null 이면 핀만 */
  label?: string | null;
  /** 가운데 위치. 없으면 서울 기본 좌표(시뮬레이션) */
  location?: { lat: number; lng: number; accuracy?: number | null } | null;
  height: number;
  /** 모서리 (기본 16) */
  radius?: number;
  /** 보호 꺼짐 — 지도를 흐리게, 핀을 회색으로 */
  dim?: boolean;
  /** 대체 가상 지도의 모양 (기본: tone 이 red 면 emergency, 아니면 home) */
  variant?: MapVariant;
  zoom?: number;
  /** 정확도 원 숨쉬기 (기본 true, 동작 줄이기면 멈춘다) */
  pulse?: boolean;
  /** 모서리 알약 자리 (안쪽 12) */
  topLeft?: React.ReactNode;
  topRight?: React.ReactNode;
  bottomLeft?: React.ReactNode;
  /** 그 밖에 겹칠 것 — 지도 상자를 기준으로 position absolute */
  children?: React.ReactNode;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * 사용 (v3·5 홈):
 * const pos = useRiderPosition();
 * <RiderMap location={pos} label="지금 여기" height={228} dim={!active}
 *   topLeft={<MapPill dot={colors.green} halo={colors.greenSoft} label="보호 중" />}
 *   bottomLeft={<MapPill icon={<LockIcon size={15} color={colors.text} />} label="사고 때만 비상연락처에 전달돼요" />} />
 * 사용 (v3·9 긴급 알림 웹): <RiderMap tone="red" label="21:42 마지막 위치" location={incident.location} height={150} />
 */
export function RiderMap({
  tone = 'dark',
  label,
  location,
  height,
  radius: rounded = radius.map,
  dim,
  variant,
  zoom = DEFAULT_ZOOM,
  pulse = true,
  topLeft,
  topRight,
  bottomLeft,
  children,
  accessibilityLabel,
  style,
}: RiderMapProps) {
  const reduced = useReducedMotion();
  const [status, setStatus] = useState<'loading' | MapCanvasStatus>(() => (canUseRealMap() ? 'loading' : 'error'));
  const [fade] = useState(() => new Animated.Value(0));
  const lat = location && Number.isFinite(location.lat) ? location.lat : SIM.position.lat;
  const lng = location && Number.isFinite(location.lng) ? location.lng : SIM.position.lng;
  const pinTone: MapPinTone = dim ? 'muted' : tone;

  const onStatus = useCallback((next: MapCanvasStatus) => setStatus(next), []);
  const onBoundaryError = useCallback(() => setStatus('error'), []);

  useEffect(() => {
    if (status !== 'ready') {
      fade.setValue(0);
      return;
    }
    if (reduced) {
      fade.setValue(1);
      return;
    }
    const anim = Animated.timing(fade, { toValue: 1, duration: motion.base, easing: motion.easeOut, useNativeDriver: motion.native });
    anim.start();
    return () => anim.stop();
  }, [status, reduced, fade]);

  const dom = useMemo(
    () => ({
      style: StyleSheet.absoluteFill,
      // 안드로이드는 react-native-webview 로 (사용자가 설치를 승인한 웹뷰)
      useExpoDOMWebView: false,
      scrollEnabled: false,
      bounces: false,
      overScrollMode: 'never' as const,
      showsHorizontalScrollIndicator: false,
      showsVerticalScrollIndicator: false,
      onError: () => setStatus('error'),
      onHttpError: () => setStatus('error'),
    }),
    [],
  );

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? (label ? `지도, ${label}` : '지도')}
      style={[styles.box, { height, borderRadius: rounded }, style]}
    >
      {status === 'error' ? (
        <MapIllustration variant={variant ?? (tone === 'red' ? 'emergency' : 'home')} marker={false} rounded={0} />
      ) : status === 'loading' ? (
        <Skeleton width="100%" height={height} radius={0} style={styles.loading} />
      ) : null}
      {status !== 'error' ? (
        <Animated.View style={[StyleSheet.absoluteFill, styles.passThrough, { opacity: fade }]}>
          <MapBoundary onError={onBoundaryError}>
            <Suspense fallback={null}>
              <MapCanvas lat={lat} lng={lng} zoom={zoom} styleUrl={MAP_STYLE_URL} palette={PALETTE} onStatus={onStatus} dom={dom} />
            </Suspense>
          </MapBoundary>
        </Animated.View>
      ) : null}
      {dim ? <View style={[StyleSheet.absoluteFill, styles.dim]} /> : null}
      <MapCenterMarker tone={pinTone} label={label} pulse={pulse && !dim} />
      {topLeft ? <View style={[styles.slot, styles.topLeft]}>{topLeft}</View> : null}
      {topRight ? <View style={[styles.slot, styles.topRight]}>{topRight}</View> : null}
      {bottomLeft ? <View style={[styles.slot, styles.bottomLeft]}>{bottomLeft}</View> : null}
      {children}
      {status === 'ready' ? (
        <View style={styles.attribution}>
          <Txt style={styles.attributionText}>© OpenStreetMap</Txt>
        </View>
      ) : null}
    </View>
  );
}

const SLOT = 12;

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: colors.mapBlock },
  passThrough: { pointerEvents: 'none' },
  loading: { position: 'absolute', left: 0, top: 0 },
  dim: { backgroundColor: colors.mapDim, pointerEvents: 'none' },
  slot: { position: 'absolute', maxWidth: '100%' },
  topLeft: { left: SLOT, top: SLOT, right: SLOT, alignItems: 'flex-start' },
  topRight: { right: SLOT, top: SLOT, alignItems: 'flex-end' },
  bottomLeft: { left: SLOT, bottom: SLOT, right: SLOT, alignItems: 'flex-start' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingLeft: 5,
    paddingRight: 11,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    boxShadow: shadow.mapPill,
  },
  pillWithIcon: { paddingLeft: 7, gap: 5 },
  pillHalo: { width: 14, height: 14, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { ...font.sans(600), fontSize: 12, lineHeight: 16, letterSpacing: -0.3, color: colors.text, flexShrink: 1 },
  attribution: {
    position: 'absolute',
    right: 4,
    bottom: 3,
    paddingHorizontal: 3,
    borderRadius: 3,
    backgroundColor: colors.mapAttributionBg,
    pointerEvents: 'none',
  },
  attributionText: { ...font.sans(500), fontSize: 8, lineHeight: 11, color: colors.mapAttributionText },
});
