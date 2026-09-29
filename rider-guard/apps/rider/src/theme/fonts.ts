/**
 * Pretendard 글꼴 원본 — 네이티브는 assets/fonts 의 .otf (웹은 fonts.web.ts 의 .woff2).
 * 라이선스: assets/fonts/Pretendard-LICENSE.txt (SIL OFL 1.1)
 */
import type { FontSource } from 'expo-font';

import { fontFamilies } from './index';

export const fontSources: Record<string, FontSource> = {
  [fontFamilies.sans400]: require('../../assets/fonts/Pretendard-Regular.otf'),
  [fontFamilies.sans500]: require('../../assets/fonts/Pretendard-Medium.otf'),
  [fontFamilies.sans600]: require('../../assets/fonts/Pretendard-SemiBold.otf'),
  [fontFamilies.sans700]: require('../../assets/fonts/Pretendard-Bold.otf'),
  [fontFamilies.sans800]: require('../../assets/fonts/Pretendard-ExtraBold.otf'),
};
