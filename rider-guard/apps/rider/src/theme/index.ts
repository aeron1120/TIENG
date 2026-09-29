/**
 * Rider Guard 공통 테마 — v3 '도로 톤' (아스팔트 · 콘크리트 · 연석 · 차선 + 보호 초록 · 신호 빨강).
 * 값은 spec-v3 화면설계 이미지에서 픽셀로 뽑았다(폰 프레임 447px = 390pt, 약 1.15px/pt).
 * 평소 화면은 무채색이고, 빨강(red…)은 사고 화면(v3·7 사고 확인 · v3·8 자동 대응 · v3·9 긴급 알림 웹)에만 쓴다.
 * 화면에서 hex·rgba 를 직접 쓰지 말고 여기서 가져다 쓸 것.
 */
import { Easing, Platform, type TextStyle } from 'react-native';

const palette = {
  /** 아스팔트 — 주 버튼 · 체크 · 스위치 · 진한 글자 */
  asphalt: '#1D1E22',
  asphaltPressed: '#34353B',
  /** 콘크리트 — 앱 바탕 */
  concrete: '#F1F1EE',
  /** 연석 — 보조 버튼 · 원 · 구분선 */
  curb: '#E3E3DF',
  curbPressed: '#D6D6D1',
  /** 차선 — 카드 */
  lane: '#FFFFFF',

  green: '#1F9E5A',
  greenSoft: '#E1F1E7',
  greenOnDark: '#3CCB81',

  red: '#E5322D',
  redPressed: '#C92A25',
  redSoft: '#FBE9E7',
  redTrack: '#F6C8C5',
  redInk: '#B9201B',

  notice: '#E6E6E2',
  noticeText: '#33343B',

  textMuted: '#66676E',
  textSubtle: '#77787D',
  textFaint: '#999CA2',

  border: '#D8D8D2',
  borderDashed: '#CFCFC9',
  haloOuter: '#E8E8E4',
  haloInner: '#DFDFDA',

  alertBg: '#0E0F12',
  darkRaised: '#2A2B30',
  darkTrack: '#3B3C40',
} as const;

export const colors = {
  // ── v3 팔레트 (새 코드는 이 이름을 쓴다) ──
  asphalt: palette.asphalt,
  asphaltPressed: palette.asphaltPressed,
  concrete: palette.concrete,
  curb: palette.curb,
  curbPressed: palette.curbPressed,
  lane: palette.lane,
  /** 보호 초록 — '보호 중' 점 · 수락함 배지 글자 */
  green: palette.green,
  /** 수락함 배지 · 초록 옅은 바탕 */
  greenSoft: palette.greenSoft,
  /** 어두운 바탕(잠금화면) 위 초록 점 */
  greenOnDark: palette.greenOnDark,
  /** 신호 빨강 — 사고 화면(v3·7·8·9)에서만 */
  red: palette.red,
  redPressed: palette.redPressed,
  /** '자동 대응 중' 배지 · 긴급 알림 카운트다운 박스 바탕 */
  redSoft: palette.redSoft,
  /** 연빨강 바탕 위 진행바 트랙 */
  redTrack: palette.redTrack,
  /** 연빨강 바탕 위 빨강 글자 */
  redInk: palette.redInk,
  /** 안내 박스(Notice) 바탕 '1순위부터 알려요…' */
  notice: palette.notice,
  noticeText: palette.noticeText,
  /** 지도 — 블록 · 도로 · 공원 · 강 · 블록 사이 골목 · 건물 */
  mapBlock: '#E3E3DF',
  mapRoad: '#FFFFFF',
  mapPark: '#DBE3D4',
  mapRiver: '#D3D9E0',
  mapRiverEdge: '#E3E7EB',
  mapGap: '#F5F5F2',
  mapBuilding: '#D8D8D3',
  mapLabel: '#8E9096',
  /** 사고 확인 SOS 구 — 위 → 아래 그라데이션, 동심원 선 */
  sosTop: '#F96C61',
  sosBottom: '#DD372F',
  sosRing: '#722E2D',
  /** 사고 확인 가운데 붉은 방사형 빛 */
  alertGlow: '#2A1415',
  /** 어두운 바탕 위 진행바 트랙 */
  darkTrack: palette.darkTrack,
  /** 어두운 바탕 위 한 단계 밝은 칸(잠금화면 알림 카드) */
  darkRaised: palette.darkRaised,
  /** 잠금화면 그라데이션 위 → 아래 */
  lockTop: '#383A42',
  lockBottom: '#0F1013',

  // ── 바탕 · 표면 ──
  bg: palette.concrete,
  surface: palette.lane,
  /** 대기 배지 · 흰 화면 안 옅은 묶음 박스 */
  surfaceMuted: '#F1F1ED',
  /** 흰 카드·행을 누르고 있는 동안 */
  surfacePressed: '#F4F4F1',

  // ── 주 색 (v3 에서는 아스팔트) ──
  primary: palette.asphalt,
  primaryPressed: palette.asphaltPressed,
  /** 보조 버튼('인증 요청') 바탕 = 연석 */
  primarySoft: palette.curb,
  primarySoftPressed: palette.curbPressed,
  /** 연석 위 글자 · 글자 버튼('변경', '+ 연락처 추가') */
  primaryInk: palette.asphalt,
  /** 안내 박스 글자 */
  primaryDeep: palette.noticeText,

  // ── 어두운 칸 (v2 남색 → v3 아스팔트) ──
  /** 대응 단계 카드(v3·8) · 어두운 버튼 */
  navy: palette.asphalt,
  navyRaised: palette.darkRaised,
  /** 어두운 바탕 위 진행바·링 트랙 */
  navyTrack: palette.darkTrack,
  /** 사고 확인 화면 바탕 */
  alertBg: palette.alertBg,
  /** 사고 확인 화면 위 카드 */
  alertCard: '#1B1C20',
  /** 어두운 바탕 위 강조(예전 보라 계열 자리) — 초록 */
  violetLight: palette.greenOnDark,
  /** 헬멧 헤일로(v3·2) 바깥 링 · 안쪽 링 */
  haloOuter: palette.haloOuter,
  haloInner: palette.haloInner,

  // ── 오류 — 평소 화면은 무채색(진한 글자 + 경고 아이콘 + 연석 박스) ──
  error: palette.asphalt,
  errorSoft: palette.notice,
  /** = error. 예전 이름(빨강이 아니다). 사고 화면의 빨강은 red 를 쓴다 */
  danger: palette.asphalt,
  /** 빨강 버튼 누름 (Button variant red/danger) */
  dangerPressed: palette.redPressed,
  /** 카운트다운 링 · 진행바 (사고 화면) */
  dangerBright: palette.red,
  /** = errorSoft (연석 박스) */
  dangerSoft: palette.notice,
  /** = error (진한 글자) */
  dangerInk: palette.asphalt,
  /** 어두운 사고 화면 위 오류 글자 */
  dangerOnDark: '#F59C96',

  // ── 글자 ──
  text: palette.asphalt,
  /** 부제목 · 보조 줄 */
  textMuted: palette.textMuted,
  /** 대기 배지 글자 등 */
  textSubtle: palette.textSubtle,
  /** '보호 시작' 같은 작은 머리말 · 비활성 탭 · 자리표시자 */
  textFaint: palette.textFaint,
  textOnDark: '#FFFFFF',
  textOnDarkMuted: '#B5B5B9',
  textOnDarkFaint: '#8E8F95',

  // ── 선 ──
  /** 흰 버튼 · 흰 화면 카드 테두리 */
  border: palette.border,
  /** 입력칸(비포커스) 테두리 */
  inputBorder: palette.curb,
  /** 카드 안 구분선 */
  divider: palette.curb,
  /** 탭바 위 선 */
  navLine: '#E7E7E3',
  /** '+ 연락처 추가'·개발용 버튼 점선 */
  borderDashed: palette.borderDashed,
  /** 아직 안 한 단계 원 · 꺼진 스위치 트랙 */
  todo: palette.border,

  // ── 입력 · 상태 ──
  placeholder: palette.textFaint,
  /** 비활성 버튼 — 흐리게 하지 않고 명확한 회색으로 */
  disabledBg: palette.curb,
  disabledText: '#A3A5AB',
  disabledOnDark: '#2E2F34',
  skeleton: '#E6E6E2',
  skeletonOnDark: '#2E2F34',
  /** 바텀시트 뒤 가림막 */
  scrim: 'rgba(15,16,19,0.45)',
  /** 입력칸 포커스 링 · 오류 링 */
  focusRing: 'rgba(29,30,34,0.08)',
  errorRing: 'rgba(29,30,34,0.10)',
  /** 어두운 바탕 위 흰 글자 버튼을 누르고 있는 동안 */
  onDarkPressed: 'rgba(255,255,255,0.08)',
  /** 어두운 바탕 위 옅은 칩 바탕 */
  onDarkChip: 'rgba(255,255,255,0.10)',
  /** 넓은 웹 화면에서 앱 프레임 바깥 */
  webBackdrop: '#E3E3DF',

  // ── 예전 이름 (v1·v2 화면 호환) — 새 코드는 위의 이름을 쓴다 ──
  ink: palette.asphalt,
  inkRaised: palette.darkRaised,
  inkTrack: palette.darkTrack,
  textOnDarkSoft: '#D9D9DC',
  borderTodo: palette.border,
  /** = primary(아스팔트). 오류 글자에는 error 를 쓴다 */
  accent: palette.asphalt,
  accentPressed: palette.asphaltPressed,
  /** = red (카운트다운 링) */
  accentBright: palette.red,
  accentGlow: palette.greenOnDark,
  accentGlowHalo: 'rgba(60,203,129,0.25)',
  accentHalo: 'rgba(29,30,34,0.14)',
  accentSoft: palette.curb,
  accentSoftText: palette.asphalt,
  accentOnDark: '#F59C96',
  info: palette.greenOnDark,
  infoSoft: palette.notice,
  infoSoftText: palette.noticeText,
  infoOnDarkSoft: 'rgba(255,255,255,0.08)',
} as const;

/** 로드되는 폰트 패밀리 이름 (Pretendard). RN 은 굵기마다 별도 패밀리로 등록해야 한다. */
export const fontFamilies = {
  sans400: 'Pretendard-Regular',
  sans500: 'Pretendard-Medium',
  sans600: 'Pretendard-SemiBold',
  sans700: 'Pretendard-Bold',
  sans800: 'Pretendard-ExtraBold',
  /** 예전 이름 — 숫자도 Pretendard(+ tabular-nums)로 */
  mono500: 'Pretendard-Medium',
  mono600: 'Pretendard-SemiBold',
  mono700: 'Pretendard-Bold',
  mono800: 'Pretendard-ExtraBold',
} as const;

export type SansWeight = 400 | 500 | 600 | 700 | 800;
export type MonoWeight = 500 | 600 | 700 | 800;

const TABULAR: TextStyle['fontVariant'] = ['tabular-nums'];

/**
 * 굵기에 맞는 fontFamily 스타일. fontWeight 를 따로 주면 안드로이드에서 가짜 볼드가 생기므로 쓰지 않는다.
 * mono = 숫자·시각용 — Pretendard 에 고정폭 숫자(tabular-nums)를 켠다. 한글이 섞여도 괜찮다.
 */
export const font = {
  sans: (weight: SansWeight = 400): TextStyle => ({ fontFamily: fontFamilies[`sans${weight}`] }),
  mono: (weight: MonoWeight = 600): TextStyle => ({ fontFamily: fontFamilies[`mono${weight}`], fontVariant: TABULAR }),
};

/** 모서리. 입력칸 14 · 버튼 16 · 카드 20 · 큰 카드 24 · 지도 16 */
export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  input: 14,
  xl: 16,
  button: 16,
  map: 16,
  card: 20,
  cardLg: 24,
  panel: 24,
  hero: 24,
  pill: 999,
} as const;

/** 그림자 — boxShadow 문자열(RN 0.76+ · 웹 공통). v3 는 평평한 톤이라 아주 옅게만. 사용: style={{ boxShadow: shadow.card }} */
export const shadow = {
  card: '0 1px 2px rgba(29,30,34,0.03)',
  raised: '0 12px 32px rgba(15,16,19,0.18)',
  hero: '0 12px 28px rgba(15,16,19,0.14)',
  nav: '0 -1px 0 rgba(29,30,34,0.02)',
  /** 지도 위 알약('보호 중', '지금 여기') */
  mapPill: '0 2px 8px rgba(29,30,34,0.12)',
  primaryButton: '0 6px 16px rgba(29,30,34,0.18)',
  onDarkButton: '0 6px 18px rgba(0,0,0,0.35)',
  /** 사고 확인 SOS 구의 붉은 빛 */
  sosGlow: '0 0 64px rgba(229,50,45,0.55)',
  /** 스위치 손잡이 */
  thumb: '0 1px 3px rgba(15,16,19,0.25)',
  /** 예전 이름 = primaryButton */
  accentButton: '0 6px 16px rgba(29,30,34,0.18)',
} as const;

/**
 * 글자 위계. 스프레드해서 쓴다: style={[typography.title, { marginTop: 4 }]}
 * 제목은 28 ExtraBold, 자간을 좁게. 본문 15, 캡션 13.
 */
export const typography = {
  /** 시작·로그인 화면 제목 (v3·1 '달리는 동안 곁에서 지켜볼게요') */
  display: { ...font.sans(800), fontSize: 28, lineHeight: 37, letterSpacing: -0.9, color: colors.text },
  /** 페이지 제목 (v3·3 '비상시 알릴 사람을 정해주세요', v3·8) */
  title: { ...font.sans(800), fontSize: 28, lineHeight: 37, letterSpacing: -0.9, color: colors.text },
  /** 카드 제목 ('1순위 김민지 확인 대기', 홈 이름) */
  heading: { ...font.sans(700), fontSize: 18, lineHeight: 26, letterSpacing: -0.3, color: colors.text },
  /** 제목 아래 부제 */
  lead: { ...font.sans(400), fontSize: 15, lineHeight: 23, color: colors.textMuted },
  body: { ...font.sans(400), fontSize: 15, lineHeight: 22, color: colors.text },
  bodyStrong: { ...font.sans(600), fontSize: 15, lineHeight: 22, color: colors.text },
  caption: { ...font.sans(400), fontSize: 13, lineHeight: 19, color: colors.textMuted },
  /** 입력칸 위 라벨 ('휴대폰 번호') */
  label: { ...font.sans(600), fontSize: 13, lineHeight: 18, color: colors.textMuted },
  /** 카드 밖 섹션 제목 ('이전 기록', 설정 묶음) */
  section: { ...font.sans(700), fontSize: 13, lineHeight: 18, color: colors.textMuted },
  small: { ...font.sans(500), fontSize: 12, lineHeight: 16, color: colors.textMuted },
  /** 작은 머리말 ('보호 시작', '지금', '착용 시간') */
  meta: { ...font.sans(500), fontSize: 12, lineHeight: 16, color: colors.textFaint },
  /** 숫자만 (시각·배터리) — 고정폭 숫자 */
  number: { ...font.mono(700), fontSize: 15, color: colors.text },
  /** 큰 숫자 ('12:40' 착용 시간, '2:41' 카운트다운) */
  numberLg: { ...font.mono(800), fontSize: 28, lineHeight: 34, letterSpacing: -0.4, color: colors.text },
} satisfies Record<string, TextStyle>;

/**
 * 모션 값. Animated 는 반드시 useNativeDriver: motion.native, easing: motion.easeOut 을 쓴다.
 * (웹은 네이티브 드라이버가 없어 false)
 */
export const motion = {
  native: Platform.OS !== 'web',
  easeOut: Easing.bezier(0.16, 1, 0.3, 1),
  fast: 160,
  base: 240,
  enter: 280,
  slow: 400,
  /** 헤일로·정확도 원 숨쉬기 한 번(들숨+날숨) */
  breathe: 2400,
  distance: 12,
  stagger: 40,
  /** 누름 스프링 — 버튼 0.97, 카드·행 0.98, 아이콘 0.9 */
  pressScale: 0.97,
  pressIn: { speed: 50, bounciness: 0 },
  pressOut: { speed: 20, bounciness: 6 },
} as const;

/** 디자인 기준 화면 크기 (390 × 844). */
export const designFrame = { width: 390, height: 844 } as const;

/** SNS 로그인 버튼 — 각 사 브랜드 가이드의 색. 앱 강조색과 섞지 않는다. */
export const socialColors = {
  kakao: { bg: '#FEE500', fg: 'rgba(0,0,0,0.85)', border: '#FEE500' },
  naver: { bg: '#03C75A', fg: '#FFFFFF', border: '#03C75A' },
  google: { bg: '#FFFFFF', fg: '#1F1F1F', border: '#747775' },
} as const;
