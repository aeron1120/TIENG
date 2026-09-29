/**
 * 가상 거리 지도 (react-native-svg) — 실제 지도(RiderMap)가 오프라인·타일 실패·웹뷰 오류일 때 대신 보여 준다.
 * v3·5 홈(연석 블록 격자 · 흰 대로 · 사선 도로 · 오른쪽 위 '시민공원' · 아래 강 · '중앙로')과
 * v3·9 긴급 알림 웹(위쪽 강 · 왼쪽 아래 공원 · 오른쪽 아래 곡선 도로 · '시장길')의 느낌을 따른다.
 * 폭에 맞춰 늘어나고(viewBox + slice) 가운데 핀 · 정확도 원 · 말풍선을 얹는다. children 은 위에 겹쳐 그린다(알약 등).
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { G, Path, Rect, Text as SvgText } from 'react-native-svg';

import { PinIcon } from '@/components/Icons';
import { Txt, useReducedMotion } from '@/components/ui';
import { colors, font, motion, radius, shadow } from '@/theme';

const VB_W = 400;
const VB_H = 240;
const CX = VB_W / 2;
const CY = VB_H / 2;

export type MapVariant = 'home' | 'emergency';
export type MapPinTone = 'dark' | 'red' | 'muted';

/** 결정적인 난수 — 매번 같은 건물 배치 */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Block = { x: number; y: number; w: number; h: number; buildings: { x: number; y: number; w: number; h: number }[] };

/** 기울어진 격자 블록 + 블록 안 건물 몇 개 */
function makeBlocks(seed: number): Block[] {
  const r = rng(seed);
  const out: Block[] = [];
  const pitchX = 50;
  const pitchY = 40;
  for (let gy = -3; gy < 10; gy++) {
    for (let gx = -3; gx < 12; gx++) {
      const x = gx * pitchX + 4;
      const y = gy * pitchY + 4;
      const w = pitchX - 8;
      const h = pitchY - 8;
      const buildings: Block['buildings'] = [];
      const n = r() < 0.55 ? Math.floor(r() * 3) : 0;
      for (let i = 0; i < n; i++) {
        const bw = 8 + r() * 10;
        const bh = 6 + r() * 8;
        buildings.push({ x: x + 3 + r() * (w - bw - 6), y: y + 3 + r() * (h - bh - 6), w: bw, h: bh });
      }
      out.push({ x, y, w, h, buildings });
    }
  }
  return out;
}

const HOME_BLOCKS = makeBlocks(7);
const EMERGENCY_BLOCKS = makeBlocks(19);

/** 격자 좌표계: 가운데(CX, CY)를 기준으로 조금 기울인다 — 지도 가운데가 교차로가 되게 격자를 옮긴다 */
const GRID_ROTATE = -9;
const GRID_SHIFT_X = CX - (4 * 50 - 4);
const GRID_SHIFT_Y = CY - (3 * 40 - 4);

function Scene({ variant }: { variant: MapVariant }) {
  const blocks = variant === 'home' ? HOME_BLOCKS : EMERGENCY_BLOCKS;
  const home = variant === 'home';
  return (
    <>
      {/* 블록 사이 골목 */}
      <Rect x={0} y={0} width={VB_W} height={VB_H} fill={colors.mapGap} />
      <G transform={`rotate(${GRID_ROTATE} ${CX} ${CY})`}>
        <G transform={`translate(${GRID_SHIFT_X} ${GRID_SHIFT_Y})`}>
          {blocks.map((b, i) => (
            <G key={i}>
              <Rect x={b.x} y={b.y} width={b.w} height={b.h} rx={2.5} fill={colors.mapBlock} />
              {b.buildings.map((bd, j) => (
                <Rect key={j} x={bd.x} y={bd.y} width={bd.w} height={bd.h} rx={1.2} fill={colors.mapBuilding} />
              ))}
            </G>
          ))}
        </G>
        {/* 대로 — 가운데에서 만나는 가로(중앙로·시장길) · 세로 */}
        <Path d={`M-200 ${CY} H${VB_W + 200}`} stroke={colors.mapRoad} strokeWidth={13} />
        <Path d={`M${CX} -200 V${VB_H + 200}`} stroke={colors.mapRoad} strokeWidth={12} />
        {/* 한 칸 건너 작은 길 */}
        <Path d={`M-200 ${CY - 80} H${VB_W + 200}`} stroke={colors.mapRoad} strokeWidth={6} />
        <Path d={`M${CX + 100} -200 V${VB_H + 200}`} stroke={colors.mapRoad} strokeWidth={6} />
        <Path d={`M${CX - 150} -200 V${VB_H + 200}`} stroke={colors.mapRoad} strokeWidth={6} />
        {/* 도로 이름 */}
        <SvgText
          x={home ? CX - 70 : CX - 105}
          y={CY + 17}
          fill={colors.mapLabel}
          fontSize={8}
          fontFamily={font.sans(500).fontFamily}
          textAnchor="middle"
        >
          {home ? '중앙로' : '시장길'}
        </SvgText>
      </G>

      {home ? (
        <>
          {/* 왼쪽 위 사선 도로 */}
          <Path d="M-20 150 L150 -20" stroke={colors.mapRoad} strokeWidth={9} />
          {/* 오른쪽 위 공원 */}
          <Path d="M296 -10 H410 V82 C396 100 360 104 330 94 C300 84 280 60 282 30 C283 10 288 0 296 -10 Z" fill={colors.mapPark} />
          <SvgText x={346} y={48} fill={colors.mapLabel} fontSize={8} fontFamily={font.sans(500).fontFamily} textAnchor="middle">
            시민공원
          </SvgText>
          {/* 아래 강 */}
          <Path d="M-20 214 C60 196 120 206 200 214 C270 221 330 200 420 192 V260 H-20 Z" fill={colors.mapRiver} />
          <Path d="M-20 214 C60 196 120 206 200 214 C270 221 330 200 420 192" stroke={colors.mapRiverEdge} strokeWidth={5} fill="none" />
        </>
      ) : (
        <>
          {/* 위쪽 강 */}
          <Path d="M-20 -10 H420 V52 C340 58 300 44 220 48 C140 52 80 64 -20 58 Z" fill={colors.mapRiver} />
          <Path d="M-20 58 C80 64 140 52 220 48 C300 44 340 58 420 52" stroke={colors.mapRiverEdge} strokeWidth={5} fill="none" />
          {/* 왼쪽 아래 공원 */}
          <Path d="M-20 170 C20 158 70 162 96 180 C114 194 110 230 100 260 H-20 Z" fill={colors.mapPark} />
          {/* 오른쪽 아래 곡선 도로 */}
          <Path d="M270 260 C290 210 330 176 420 160" stroke={colors.mapRoad} strokeWidth={9} fill="none" />
          <Path d="M320 260 C334 226 362 204 420 194" stroke={colors.mapRoad} strokeWidth={6} fill="none" />
        </>
      )}
    </>
  );
}

const MemoScene = memo(Scene);

// ── 가운데 핀 ─────────────────────────────────────────────────

const PIN_W = 28;
const PIN_H = 38;
const ACCURACY = 48;

const PIN_COLORS: Record<MapPinTone, { pin: string; fill: string; ring: string }> = {
  dark: { pin: colors.asphalt, fill: 'rgba(29,30,34,0.07)', ring: 'rgba(29,30,34,0.28)' },
  red: { pin: colors.red, fill: 'rgba(229,50,45,0.14)', ring: 'rgba(229,50,45,0.45)' },
  muted: { pin: colors.textFaint, fill: 'rgba(29,30,34,0.04)', ring: 'rgba(29,30,34,0.14)' },
};

type MapCenterMarkerProps = {
  tone?: MapPinTone;
  /** 핀 오른쪽 말풍선 ('지금 여기', '21:42 마지막 위치'). 없으면 핀만 */
  label?: string | null;
  /** 정확도 원 지름 (기본 48) */
  accuracySize?: number;
  /** 정확도 원이 천천히 숨쉰다 (동작 줄이기면 멈춘다) */
  pulse?: boolean;
};

/**
 * 지도 가운데 표시 — 핀 끝이 지도 한가운데에 오고, 그 둘레에 반투명 정확도 원, 핀 머리 오른쪽에 어두운 말풍선.
 * 지도 위 absoluteFill 로 겹쳐 그린다(누르기 막지 않음). RiderMap 과 MapIllustration 이 같이 쓴다.
 */
export function MapCenterMarker({ tone = 'dark', label, accuracySize = ACCURACY, pulse = true }: MapCenterMarkerProps) {
  const c = PIN_COLORS[tone];
  const reduced = useReducedMotion();
  const on = pulse && !reduced;
  const [breath] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!on) {
      breath.setValue(0);
      return;
    }
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: motion.breathe / 2, easing: ease, useNativeDriver: motion.native }),
        Animated.timing(breath, { toValue: 0, duration: motion.breathe / 2, easing: ease, useNativeDriver: motion.native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, on]);
  const scale = useMemo(() => breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] }), [breath]);
  const opacity = useMemo(() => breath.interpolate({ inputRange: [0, 1], outputRange: [1, 0.7] }), [breath]);

  return (
    <View style={[StyleSheet.absoluteFill, styles.passThrough]}>
      <View style={styles.markerOrigin}>
        <Animated.View
          style={[
            styles.accuracy,
            {
              width: accuracySize,
              height: accuracySize,
              borderRadius: accuracySize / 2,
              left: -accuracySize / 2,
              top: -accuracySize / 2,
              backgroundColor: c.fill,
              borderColor: c.ring,
              opacity,
              transform: [{ scale }],
            },
          ]}
        />
        <View style={styles.pinShadow} />
        <View style={styles.pin}>
          <PinIcon size={PIN_H} color={c.pin} />
        </View>
        {label ? (
          <View style={styles.bubble}>
            <Txt numberOfLines={1} style={styles.bubbleText}>
              {label}
            </Txt>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── 가상 지도 ─────────────────────────────────────────────────

type MapIllustrationProps = {
  /** home = v3·5 홈, emergency = v3·9 긴급 알림 웹 */
  variant?: MapVariant;
  /** 핀 색 — dark(아스팔트) · red(빨강, 사고 화면만) · muted(보호 꺼짐) */
  pinTone?: MapPinTone;
  /** 핀 말풍선 ('지금 여기' · '21:42 마지막 위치') */
  pinLabel?: string | null;
  /** 가운데 핀을 그릴지 (RiderMap 이 대체 화면으로 쓸 때는 끄고 자기 핀을 그린다) */
  marker?: boolean;
  /** 정확도 원 숨쉬기 */
  pulse?: boolean;
  /** 높이 — 없으면 부모를 채운다(absoluteFill 로 쓸 때) */
  height?: number;
  /** 모서리 (기본 radius.map 16) */
  rounded?: number;
  /** 위에 겹칠 요소 — 알약 등. 부모를 기준으로 position absolute 로 둔다 */
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * 가상 거리 지도. 사용:
 * <MapIllustration variant="home" pinLabel="지금 여기" height={228}>
 *   <MapPill … style={{ position: 'absolute', left: 12, top: 12 }} />
 * </MapIllustration>
 */
export function MapIllustration({
  variant = 'home',
  pinTone = 'dark',
  pinLabel,
  marker = true,
  pulse = true,
  height,
  rounded = radius.map,
  children,
  style,
}: MapIllustrationProps) {
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={pinLabel ? `지도, ${pinLabel}` : '지도'}
      style={[styles.box, height == null ? StyleSheet.absoluteFill : { height }, { borderRadius: rounded }, style]}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid slice" style={StyleSheet.absoluteFill}>
        <MemoScene variant={variant} />
      </Svg>
      {marker ? <MapCenterMarker tone={pinTone} label={pinLabel} pulse={pulse} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: colors.mapBlock },
  passThrough: { pointerEvents: 'none' },
  /** 지도 한가운데 0×0 점 — 핀 끝 · 정확도 원 가운데 */
  markerOrigin: { position: 'absolute', left: '50%', top: '50%', width: 0, height: 0 },
  accuracy: { position: 'absolute', borderWidth: 1 },
  pinShadow: {
    position: 'absolute',
    left: -6,
    top: -2.5,
    width: 12,
    height: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(29,30,34,0.16)',
  },
  pin: { position: 'absolute', left: -PIN_H / 2, top: -PIN_H + 1, width: PIN_H, height: PIN_H },
  bubble: {
    position: 'absolute',
    left: PIN_W / 2 + 4,
    top: -PIN_H + 1 + PIN_H * 0.41 - 13,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.asphalt,
    justifyContent: 'center',
    boxShadow: shadow.mapPill,
  },
  bubbleText: { ...font.sans(700), fontSize: 13, lineHeight: 18, color: colors.textOnDark },
});
