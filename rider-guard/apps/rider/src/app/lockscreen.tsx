// 디자인: spec-v3 06 '잠금화면 상시 알림' — 보호 중 안드로이드 잠금화면에 뜨는 상시 알림을 앱 안에서 그대로 보여 주는 미리보기.
// 착용 시간은 실제 보호 시작(me.session)부터, 보호 중이 아니면 12:40 에서 시작하는 시뮬레이션. 배터리·수락은 시뮬레이션 값.
// 화면 아무 곳이나 누르거나 뒤로 가면 닫힌다.
import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useMe } from '@/api/hooks';
import { LogoIcon } from '@/components/Icons';
import { FadeIn, PressableScale, ProgressBar, PulseHalo, screenTopPadding, Txt } from '@/components/ui';
import { acceptedCountText, useContactAcceptance } from '@/features/contactSim';
import { helmetInfo } from '@/features/helmet';
import { SIM, useNow, useSimNotifications, wearTime } from '@/features/sim';
import { backOr } from '@/lib/nav';
import { batteryText, dayLabel, timeHM } from '@/lib/format';
import { colors, font, motion, radius } from '@/theme';

/** 보호 중이 아닐 때 착용 시간 시뮬레이션의 시작 (디자인의 '12:40') */
const SIM_WEAR_S = 12 * 60 + 40;

const close = () => backOr('/home');

export default function LockscreenScreen() {
  const insets = useSafeAreaInsets();
  const { data: me } = useMe();
  const acc = useContactAcceptance(me?.contacts);
  const { items } = useSimNotifications(me);
  const [openedAt] = useState(() => Date.now());
  const now = useNow(1000);

  const startedAt = me?.session?.startedAt ?? openedAt - SIM_WEAR_S * 1000;
  // 상시 알림은 보호 중(헬멧 착용)에만 뜬다
  const helmet = helmetInfo(me?.device, true);
  const battery = helmet.battery ?? SIM.battery;
  // 연락처가 없으면(또는 아직 못 읽었으면) 디자인 그대로의 시뮬레이션 값
  const hasContacts = !!me?.contacts.length;
  const contactsLine = hasContacts ? acceptedCountText(acc.summary) : '비상연락처 1명 수락';
  const notice = (hasContacts ? (items.find((n) => n.kind === 'contact') ?? items.find((n) => n.kind === 'pending')) : null) ?? {
    title: '비상연락처 수락',
    body: `${SIM.contactNames[0]}님이 비상연락처 요청을 수락했어요.`,
    ago: `${SIM.acceptedAgoMin}분 전`,
  };

  const wear = wearTime(startedAt, now);
  const helmetLine = `헬멧 ${helmet.connected ? '연결됨' : '연결 끊김'}, ${contactsLine}`;

  // 바깥(배경 탭으로 닫기)은 스크린리더가 한 덩어리 버튼으로 읽지 않게 하고, 카드마다 내용을 요약해 읽힌다
  return (
    <Pressable accessible={false} onPress={close} style={styles.root}>
      <LockBackground />
      <View style={[styles.content, { paddingTop: screenTopPadding(TOP, insets.top), paddingBottom: insets.bottom }]}>
        <FadeIn offset={0} duration={motion.slow}>
          <Txt style={styles.date}>{dayLabel(new Date(now))}</Txt>
          <Txt style={styles.clock} accessibilityLabel={`지금 ${timeHM(now)}`}>
            {timeHM(now)}
          </Txt>
        </FadeIn>

        <FadeIn delay={motion.stagger * 3} offset={motion.distance} style={styles.cardGap}>
          <PressableScale
            onPress={close}
            accessibilityLabel={`Rider Guard 실시간 알림. 보호 중, 착용 시간 ${wear}. ${helmetLine}. 헬멧 배터리 ${batteryText(battery)}`}
            accessibilityHint="누르면 미리보기를 닫아요"
            style={styles.live}
            pressedStyle={styles.pressed}
          >
            <View style={styles.head}>
              <LogoIcon size={28} color={colors.surface} fg={colors.asphalt} check={false} />
              <Txt style={styles.app}>Rider Guard</Txt>
              <Txt style={styles.meta}>실시간</Txt>
            </View>

            <View style={styles.statusRow}>
              <View style={styles.statusLeft}>
                <View style={styles.dotBox}>
                  {/* 점 둘레 옅은 초록 링 — 천천히 숨쉰다 (동작 줄이기면 멈춘 링) */}
                  <PulseHalo size={DOT_RING} color={colors.accentGlowHalo} mode="breathe" scaleTo={1.15} />
                  <View style={styles.dot} />
                </View>
                <Txt style={styles.status}>보호 중</Txt>
              </View>
              <Txt style={styles.wear}>{wear}</Txt>
            </View>

            <View style={styles.subRow}>
              <Txt numberOfLines={1} style={styles.sub}>
                {helmetLine}
              </Txt>
              <Txt style={styles.wearLabel}>착용 시간</Txt>
            </View>

            <ProgressBar value={battery / 100} height={6} onDark trackColor={colors.lockTrack} accessibilityLabel="헬멧 배터리" style={styles.bar} />
            <View style={styles.batteryRow}>
              <Txt style={styles.label}>헬멧 배터리</Txt>
              <Txt style={styles.percent}>{batteryText(battery)}</Txt>
            </View>
          </PressableScale>
        </FadeIn>

        <FadeIn delay={motion.stagger * 5} offset={motion.distance} style={styles.noticeGap}>
          <PressableScale
            onPress={close}
            accessibilityLabel={`${notice.title}, ${notice.body}, ${notice.ago}`}
            accessibilityHint="누르면 미리보기를 닫아요"
            style={styles.notice}
            pressedStyle={styles.pressed}
          >
            <LogoIcon size={28} color={colors.surface} fg={colors.asphalt} check={false} />
            <View style={styles.noticeMain}>
              <View style={styles.noticeHead}>
                <Txt numberOfLines={1} style={styles.noticeTitle}>
                  {notice.title}
                </Txt>
                <Txt style={styles.noticeAgo}>{notice.ago}</Txt>
              </View>
              <Txt style={styles.noticeBody}>{notice.body}</Txt>
            </View>
          </PressableScale>
        </FadeIn>
      </View>
      <View style={[styles.homeBar, { bottom: Math.max(insets.bottom - 26, 0) + 9 }]} />
    </Pressable>
  );
}

/** 타원 가로:세로 */
const STRETCH = 1.17;
/** [위치, lockTop 의 불투명도] — 디자인 가운데 세로선에서 잰 밝기 (바탕은 lockBottom) */
const GLOW_STOPS = [
  [0, 1],
  [0.12, 0.78],
  [0.21, 0.61],
  [0.3, 0.37],
  [0.39, 0.29],
  [0.58, 0.15],
  [0.7, 0.1],
  [1, 0],
] as const;

/** 위 가운데가 밝고 아래로 어두워지는 타원 그라데이션 (lockTop → lockBottom). 폭이 높이보다 1.17배 넓은 타원 */
function LockBackground() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
  };
  const r = Math.max(size.h, 1) * 1.02;
  return (
    <View style={[StyleSheet.absoluteFill, styles.bg]} onLayout={onLayout}>
      {size.w > 0 ? (
        <Svg width={size.w} height={size.h}>
          <Defs>
            <RadialGradient
              id="lockGlow"
              gradientUnits="userSpaceOnUse"
              cx={size.w / 2 / STRETCH}
              cy={0}
              fx={size.w / 2 / STRETCH}
              fy={0}
              r={r}
              gradientTransform={`scale(${STRETCH} 1)`}
            >
              {GLOW_STOPS.map(([offset, opacity]) => (
                <Stop key={offset} offset={offset} stopColor={colors.lockTop} stopOpacity={opacity} />
              ))}
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width={size.w} height={size.h} fill="url(#lockGlow)" />
        </Svg>
      ) : null}
    </View>
  );
}

/** 날짜 줄의 디자인 y (상태바 44 포함) — 웹은 그대로, 네이티브는 상태바 아래 53 */
const TOP = 97;
const DOT = 9;
const DOT_RING = 14.5;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.lockBottom },
  bg: { backgroundColor: colors.lockBottom, pointerEvents: 'none' },
  content: { flex: 1, paddingHorizontal: 14 },
  date: { ...font.sans(600), fontSize: 18, lineHeight: 24, letterSpacing: -0.2, color: colors.textOnDarkSoft, textAlign: 'center' },
  // 고정폭 숫자를 좁게 모은 큰 시계 (디자인 '21:14' 글리프 폭 234.5 · 높이 64)
  clock: { ...font.mono(800), fontSize: 88, lineHeight: 95, letterSpacing: -4, color: colors.textOnDark, textAlign: 'center' },

  cardGap: { marginTop: 83.5 },
  live: {
    paddingTop: 15.5,
    paddingBottom: 14,
    paddingHorizontal: 18,
    borderRadius: radius.panel,
    borderWidth: 1,
    borderColor: colors.lockCardEdge,
    backgroundColor: colors.lockCard,
  },
  pressed: { backgroundColor: colors.lockCardPressed },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  app: { ...font.sans(700), flex: 1, fontSize: 15, lineHeight: 20, letterSpacing: -0.2, color: colors.textOnDark },
  meta: { ...font.sans(400), fontSize: 12.5, lineHeight: 18, color: colors.textOnDarkMuted },

  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: -3 },
  dotBox: { width: DOT_RING, height: DOT_RING, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.greenOnDark },
  status: { ...font.sans(800), fontSize: 24, lineHeight: 30, color: colors.textOnDark },
  wear: { ...font.mono(800), fontSize: 28, lineHeight: 34, color: colors.textOnDark },

  subRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  sub: { ...font.sans(400), flexShrink: 1, fontSize: 13.5, lineHeight: 20, color: colors.textOnDarkSoft },
  wearLabel: { ...font.sans(400), fontSize: 12, lineHeight: 18, letterSpacing: -0.3, color: colors.textOnDarkMuted },
  label: { ...font.sans(400), fontSize: 13, lineHeight: 18, letterSpacing: -0.5, color: colors.textOnDarkMuted },
  bar: { marginTop: 13.5 },
  batteryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 },
  percent: { ...font.mono(500), fontSize: 13, lineHeight: 18, color: colors.textOnDarkMuted },

  noticeGap: { marginTop: 32 },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingTop: 13.5,
    paddingBottom: 12,
    paddingLeft: 15.5,
    paddingRight: 16,
    borderRadius: radius.card,
    backgroundColor: colors.lockCard,
  },
  noticeMain: { flex: 1, marginTop: 1.5 },
  noticeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  noticeTitle: { ...font.sans(700), flexShrink: 1, fontSize: 14, lineHeight: 20, letterSpacing: -0.3, color: colors.textOnDarkSoft },
  noticeAgo: { ...font.sans(400), fontSize: 13, lineHeight: 18, letterSpacing: -0.3, color: colors.textOnDarkMuted },
  noticeBody: { ...font.sans(400), fontSize: 13.5, lineHeight: 19, color: colors.textOnDarkSoft },

  homeBar: { position: 'absolute', alignSelf: 'center', width: 134, height: 5, borderRadius: 3, backgroundColor: colors.homeIndicator },
});
