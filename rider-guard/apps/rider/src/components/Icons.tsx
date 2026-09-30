/**
 * v3 라인 아이콘 (24×24, 선 2, 둥근 끝). 모두 (p: IconProps) 로 같은 시그니처 — <ShieldIcon size={20} color={colors.text} />
 * 기본 색은 본문 글자색. 채움이 필요한 것(로고·지도 핀·빨간 느낌표)만 따로 그린다.
 */
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '@/theme';

export type IconProps = { size?: number; color?: string; strokeWidth?: number };
export type IconComponent = (p: IconProps) => React.ReactElement;

/** 디자인의 24×24 라인 아이콘 공통 틀. */
function Line({ size = 24, color = colors.text, strokeWidth = 2, children }: IconProps & { children: React.ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  );
}

const SHIELD = 'M12 3l7 2.7v5.5c0 4.4-2.9 8-7 9.8-4.1-1.8-7-5.4-7-9.8V5.7z';

/**
 * 앱 로고 타일 — 둥근 사각 안에 방패(+ 체크) (v3·1 머리글 28 · v3·9 긴급 알림 · v3·6 잠금화면은 흰 타일).
 * color = 타일 바탕(기본 아스팔트), fg = 방패 선(기본 흰색), check = 방패 안 체크(기본 true), size = 한 변.
 */
export function LogoIcon({ size = 28, color = colors.asphalt, fg = colors.textOnDark, check = true }: IconProps & { fg?: string; check?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <Rect width="28" height="28" rx="8" fill={color} />
      <Path d="M14 7.2l5 1.9v3.8c0 3.1-2.1 5.6-5 6.9-2.9-1.3-5-3.8-5-6.9V9.1z" stroke={fg} strokeWidth={1.7} strokeLinejoin="round" />
      {check ? <Path d="M11.9 13.3l1.5 1.5 2.8-2.9" stroke={fg} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" /> : null}
    </Svg>
  );
}

// ── 보호 · 헬멧 ────────────────────────────────────────────────

/** 방패 — 보호 탭 */
export const ShieldIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d={SHIELD} />
  </Line>
);

export const ShieldCheckIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d={SHIELD} />
    <Path d="M9 12l2.2 2.2L15.2 10" />
  </Line>
);

/** 헬멧 옆모습 — 둥근 갓 + 오른쪽 바이저 (v3·2 가운데 원 · v3·5 '헬멧' 머리말) */
export const HelmetIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M3.5 19V17.5C3.5 10.3 7.3 5 12.4 5c3.5 0 6.4 2.3 8.1 5.8V19z" />
    <Path d="M20.5 10.8H15a1.8 1.8 0 0 0-1.8 1.8v.4A1.8 1.8 0 0 0 15 14.8h5.5" />
  </Line>
);

/** 음성 응답 — 막대 5개 (v3·5 '음성 응답', v3·7 '"괜찮아"라고 말해도 돼요') */
export const WaveformIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M4 10.5v3M8 7.5v9M12 4.5v15M16 7.5v9M20 10.5v3" />
  </Line>
);

export const MicIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="9" y="3" width="6" height="11" rx="3" />
    <Path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <Path d="M12 17.5V21" />
  </Line>
);

export const BatteryIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="3" y="7" width="16" height="10" rx="2" />
    <Path d="M21 11v2" />
    <Path d="M6 10v4" />
    <Path d="M9 10v4" />
  </Line>
);

export const CameraDeviceIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="3" y="5" width="18" height="12" rx="2" />
    <Circle cx="12" cy="11" r="3" />
    <Path d="M8 21h8" />
  </Line>
);

// ── 사람 · 연락 ────────────────────────────────────────────────

/** 비상연락처 — 두 사람 */
export const UsersIcon = (p: IconProps) => (
  <Line {...p}>
    <Circle cx="9" cy="8" r="3.2" />
    <Path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <Path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    <Path d="M17.5 14.2a5.5 5.5 0 0 1 3 5.3" />
  </Line>
);

/** 예전 이름 = UsersIcon */
export const ContactsIcon = UsersIcon;

/** 전화 수화기 (v3·5 비상연락처 원 · v3·8 '119 전화' · v3·9 '[라이더 이름]님에게 전화') */
export const PhoneIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M21 16.4v2.8a1.9 1.9 0 0 1-2.1 1.9 18.8 18.8 0 0 1-8.2-2.9 18.5 18.5 0 0 1-5.7-5.7A18.8 18.8 0 0 1 2.1 4.2 1.9 1.9 0 0 1 4 2.1h2.8a1.9 1.9 0 0 1 1.9 1.6c.1.9.3 1.8.7 2.7a1.9 1.9 0 0 1-.4 2L7.8 9.6a15.2 15.2 0 0 0 5.7 5.7l1.2-1.2a1.9 1.9 0 0 1 2-.4c.9.3 1.8.6 2.7.7a1.9 1.9 0 0 1 1.6 2z" />
  </Line>
);

export const MailIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <Path d="M4 7l8 6 8-6" />
  </Line>
);

/** 말풍선 + 줄 (v3·4 '받게 되는 것') */
export const MessageLinesIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9.2L4.5 20z" />
    <Path d="M8.5 9h4.5" />
    <Path d="M8.5 12.5h7" />
  </Line>
);

// ── 지도 · 위치 ────────────────────────────────────────────────

/** 위치 핀 선 아이콘 (v3·5 '위치 수집') */
export const MapPinIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M12 21.2s-6.6-5.7-6.6-11.2a6.6 6.6 0 0 1 13.2 0c0 5.5-6.6 11.2-6.6 11.2z" />
    <Circle cx="12" cy="10" r="2.4" />
  </Line>
);

/**
 * 채운 물방울 핀 + 흰 점 (지도 위 '지금 여기' · 긴급 알림 '마지막 위치'). color = 핀 색, dotColor = 가운데 점.
 * 뾰족한 끝이 아래 가운데(12, 23)라서 핀 끝을 좌표에 맞출 때는 아이콘 아래 가운데를 기준으로 둔다.
 */
export function PinIcon({ size = 24, color = colors.asphalt, dotColor = colors.textOnDark }: IconProps & { dotColor?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 23c-.4 0-.8-.2-1-.5C8.4 19 4.5 14.3 4.5 9.8a7.5 7.5 0 0 1 15 0c0 4.5-3.9 9.2-6.5 12.7-.2.3-.6.5-1 .5z" fill={color} />
      <Circle cx="12" cy="9.8" r="2.9" fill={dotColor} />
    </Svg>
  );
}

/** 자물쇠 (v3·5 '사고 때만 비상연락처에 전달돼요') */
export const LockIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="5" y="10.5" width="14" height="10" rx="2.2" />
    <Path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
  </Line>
);

/** 오른쪽 위 화살표 ('지도 앱에서 열기 ↗') */
export const ArrowUpRightIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M7 17L17 7" />
    <Path d="M8.5 7H17v8.5" />
  </Line>
);

// ── 탭 · 머리글 ────────────────────────────────────────────────

/** 기록 — 모서리 접힌 문서 + 줄 (v3 탭바) */
export const DocIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z" />
    <Path d="M14 3v3.5A1.5 1.5 0 0 0 15.5 8H19" />
    <Path d="M9 9.5h2" />
    <Path d="M9 13h6" />
    <Path d="M9 16.5h6" />
  </Line>
);

/** 예전 이름 = DocIcon */
export const RecordsIcon = DocIcon;

/** 설정 — 톱니바퀴 (v3 탭바) */
export const GearIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M12.2 2.5h-.4a1.9 1.9 0 0 0-1.9 1.9v.2a1.9 1.9 0 0 1-.9 1.6l-.4.2a1.9 1.9 0 0 1-1.9 0l-.1-.1a1.9 1.9 0 0 0-2.6.7l-.2.4a1.9 1.9 0 0 0 .7 2.6l.1.1a1.9 1.9 0 0 1 .9 1.6v.5a1.9 1.9 0 0 1-.9 1.7l-.1.1a1.9 1.9 0 0 0-.7 2.6l.2.4a1.9 1.9 0 0 0 2.6.7l.1-.1a1.9 1.9 0 0 1 1.9 0l.4.2a1.9 1.9 0 0 1 .9 1.6v.2a1.9 1.9 0 0 0 1.9 1.9h.4a1.9 1.9 0 0 0 1.9-1.9v-.2a1.9 1.9 0 0 1 .9-1.6l.4-.2a1.9 1.9 0 0 1 1.9 0l.1.1a1.9 1.9 0 0 0 2.6-.7l.2-.4a1.9 1.9 0 0 0-.7-2.6l-.1-.1a1.9 1.9 0 0 1-.9-1.7v-.5a1.9 1.9 0 0 1 .9-1.6l.1-.1a1.9 1.9 0 0 0 .7-2.6l-.2-.4a1.9 1.9 0 0 0-2.6-.7l-.1.1a1.9 1.9 0 0 1-1.9 0l-.4-.2a1.9 1.9 0 0 1-.9-1.6v-.2a1.9 1.9 0 0 0-1.9-1.9z" />
    <Circle cx="12" cy="12" r="3" />
  </Line>
);

/** 예전 이름 = GearIcon */
export const SettingsIcon = GearIcon;

export const HomeIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M4 11l8-7 8 7v9H4z" />
  </Line>
);

/** 알림 종 (v3·5 홈 오른쪽 위) */
export const BellIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M6 17v-6a6 6 0 0 1 12 0v6" />
    <Path d="M4.5 17h15" />
    <Path d="M10.4 20.2a1.8 1.8 0 0 0 3.2 0" />
  </Line>
);

// ── 방향 · 동작 ────────────────────────────────────────────────

export const ChevronLeftIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M15 5l-7 7 7 7" />
  </Line>
);

/** 예전 이름 = ChevronLeftIcon */
export const BackIcon = ChevronLeftIcon;

export const ChevronRightIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M9 5l7 7-7 7" />
  </Line>
);

export const CheckIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M5 12.5l4.5 4.5L19 7.5" />
  </Line>
);

export const PlusIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M12 5v14M5 12h14" />
  </Line>
);

export const CloseIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M6 6l12 12M18 6L6 18" />
  </Line>
);

export const PencilIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M4 20h4L19 9l-4-4L4 16z" />
  </Line>
);

/** 겹친 두 사각형 ('문구 복사') */
export const CopyIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2" />
    <Path d="M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1a2.2 2.2 0 0 0 2.2 2.2h2.3" />
  </Line>
);

/** 문 + 오른쪽 화살표 (v3·4 '언제든 그만두기') */
export const LogOutIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M10 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H10" />
    <Path d="M10.5 12H20" />
    <Path d="M16.5 8.5L20 12l-3.5 3.5" />
  </Line>
);

// ── 상태 · 안내 ────────────────────────────────────────────────

export const InfoIcon = (p: IconProps) => (
  <Line {...p}>
    <Circle cx="12" cy="12" r="9" />
    <Path d="M12 11v5" />
    <Path d="M12 7.5v.01" />
  </Line>
);

/** 원 안 느낌표 (선) */
export const AlertIcon = (p: IconProps) => (
  <Line {...p}>
    <Circle cx="12" cy="12" r="9" />
    <Path d="M12 8v5" />
    <Path d="M12 16.5v.01" />
  </Line>
);

/**
 * 채운 원 + 느낌표 (v3·7 '강한 충격이 감지됐어요' 배지 — 흰 원에 빨간 느낌표).
 * color = 원, markColor = 느낌표.
 */
export function AlertCircleFilledIcon({ size = 24, color = colors.textOnDark, markColor = colors.red }: IconProps & { markColor?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="10" fill={color} />
      <Path d="M12 7v6.2" stroke={markColor} strokeWidth={2.6} strokeLinecap="round" />
      <Circle cx="12" cy="16.9" r="1.45" fill={markColor} />
    </Svg>
  );
}

/** 경고 삼각형 (v3·9 긴급 알림 머리 · 평소 화면 오류 표시) */
export const WarningTriangleIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M10.3 4.3L2.9 17.4a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
    <Path d="M12 9.5v4.3" />
    <Path d="M12 17.2v.01" />
  </Line>
);

export const ClockIcon = (p: IconProps) => (
  <Line {...p}>
    <Circle cx="12" cy="12" r="9" />
    <Path d="M12 7v5l3 2" />
  </Line>
);

export const EyeIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <Circle cx="12" cy="12" r="3" />
  </Line>
);

/** 눈 + 사선 (v3·4 '볼 수 없는 것', 비밀번호 숨기기) */
export const EyeOffIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.4 3.3" />
    <Path d="M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5" />
    <Path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <Path d="M3 3l18 18" />
  </Line>
);
