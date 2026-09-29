/**
 * Rider Guard 공통 테마.
 * 값은 design/*.dc.html 에서 추출했다. 화면에서 hex 값을 직접 쓰지 말고 여기서 가져다 쓸 것.
 */
import type { TextStyle } from 'react-native';

export const colors = {
  // 바탕 · 표면
  bg: '#F4F1EA',
  surface: '#FFFFFF',
  surfaceMuted: '#EDE9E0',
  ink: '#16181D', // 본문 글자, 다크 카드/사고 화면 배경
  inkRaised: '#262930', // 다크 카드 안쪽 타일
  inkTrack: '#2C2F37', // 카운트다운 링 트랙

  // 글자
  text: '#16181D',
  textMuted: '#5B5E66',
  textSubtle: '#45474D',
  textOnDark: '#FFFFFF',
  textOnDarkMuted: '#B7BAC2',
  textOnDarkSoft: '#D4D6DB',
  textOnDarkFaint: '#9A9DA6',

  // 선
  border: '#DDD6C8',
  borderDashed: '#A8A194',
  borderTodo: '#C9C2B4',
  divider: '#EDE9E0',

  // 브랜드 (주황)
  accent: '#C2410C',
  accentPressed: '#9A3412',
  accentBright: '#F97316', // 카운트다운 링
  accentGlow: '#FB923C', // 운행 중 표시등
  accentGlowHalo: 'rgba(251,146,60,0.25)',
  accentSoft: '#FDE3D3', // 배지 배경
  accentSoftText: '#9A3412',
  accentOnDark: '#FDBA8C',

  // 정보 (파랑)
  info: '#93B4FF',
  infoSoft: '#DBE4FB',
  infoSoftText: '#1D3FA8',
} as const;

/** 로드되는 폰트 패밀리 이름. RN 은 굵기마다 별도 패밀리로 등록해야 한다. */
export const fontFamilies = {
  sans400: 'IBMPlexSansKR_400Regular',
  sans500: 'IBMPlexSansKR_500Medium',
  sans600: 'IBMPlexSansKR_600SemiBold',
  sans700: 'IBMPlexSansKR_700Bold',
  mono500: 'IBMPlexMono_500Medium',
  mono600: 'IBMPlexMono_600SemiBold',
} as const;

type SansWeight = 400 | 500 | 600 | 700;
type MonoWeight = 500 | 600;

/** 굵기에 맞는 fontFamily 스타일. fontWeight 를 따로 주면 안드로이드에서 가짜 볼드가 생기므로 쓰지 않는다. */
export const font = {
  sans: (weight: SansWeight = 400): TextStyle => ({ fontFamily: fontFamilies[`sans${weight}`] }),
  mono: (weight: MonoWeight = 500): TextStyle => ({ fontFamily: fontFamilies[`mono${weight}`] }),
};

export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  card: 16,
  hero: 18,
  panel: 20,
  pill: 999,
} as const;

/** 디자인 기준 화면 크기 (390 × 844). */
export const designFrame = { width: 390, height: 844 } as const;

/** SNS 로그인 버튼 — 각 사 브랜드 가이드의 색. 앱 강조색과 섞지 않는다. */
export const socialColors = {
  kakao: { bg: '#FEE500', fg: 'rgba(0,0,0,0.85)', border: '#FEE500' },
  naver: { bg: '#03C75A', fg: '#FFFFFF', border: '#03C75A' },
  google: { bg: '#FFFFFF', fg: '#1F1F1F', border: '#747775' },
} as const;
