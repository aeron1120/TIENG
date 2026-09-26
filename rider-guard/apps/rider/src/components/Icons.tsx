import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '@/theme';

type IconProps = { size?: number; color?: string; strokeWidth?: number };

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

export function LogoIcon({ size = 32, color = colors.accent }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 20a11 11 0 0 1 22 0v3H5z" />
      <Path d="M16 9v6" />
      <Path d="M9 23v3h14v-3" />
    </Svg>
  );
}

export const BellIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" />
    <Path d="M10 21h4" />
  </Line>
);

export const HelmetIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M4 16a8 8 0 0 1 16 0v2H4z" />
    <Path d="M12 8v4" />
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

export const PinIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
    <Circle cx="12" cy="10" r="2" />
  </Line>
);

export const PhoneIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  </Line>
);

export const CameraDeviceIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="3" y="5" width="18" height="12" rx="2" />
    <Circle cx="12" cy="11" r="3" />
    <Path d="M8 21h8" />
  </Line>
);

export const PencilIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M4 20h4L19 9l-4-4L4 16z" />
  </Line>
);

export const BackIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M15 5l-7 7 7 7" />
  </Line>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M9 5l7 7-7 7" />
  </Line>
);

export const CheckIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M5 12l5 5 9-10" />
  </Line>
);

export const HomeIcon = (p: IconProps) => (
  <Line {...p}>
    <Path d="M4 11l8-7 8 7v9H4z" />
  </Line>
);

export const RecordsIcon = (p: IconProps) => (
  <Line {...p}>
    <Rect x="5" y="3" width="14" height="18" rx="2" />
    <Path d="M9 8h6" />
    <Path d="M9 12h6" />
    <Path d="M9 16h3" />
  </Line>
);

export const ContactsIcon = (p: IconProps) => (
  <Line {...p}>
    <Circle cx="9" cy="8" r="3" />
    <Path d="M3 20a6 6 0 0 1 12 0" />
    <Path d="M16 5a3 3 0 0 1 0 6" />
    <Path d="M18 14a5 5 0 0 1 3 6" />
  </Line>
);

export const SettingsIcon = (p: IconProps) => (
  <Line {...p}>
    <Circle cx="12" cy="12" r="3" />
    <Path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </Line>
);
