/**
 * Pretendard 글꼴 원본 — 네이티브는 assets/fonts 의 .subset.otf (웹은 fonts.web.ts 의 .woff2).
 * 부분집합은 웹 woff2 와 같은 3,728자(자주 쓰는 한글·라틴·기호)에 레이아웃 기능(tnum 등)을 모두 남겨 fontTools 로 만들었다 —
 * 전체 글꼴(각 1.6MB)보다 APK·시작 로딩이 가볍다. 없는 글자는 기기 글꼴로 그려진다.
 * 라이선스: assets/fonts/Pretendard-LICENSE.txt (SIL OFL 1.1)
 */
import type { FontSource } from 'expo-font';

import { fontFamilies } from './index';

export const fontSources: Record<string, FontSource> = {
  [fontFamilies.sans400]: require('../../assets/fonts/Pretendard-Regular.subset.otf'),
  [fontFamilies.sans500]: require('../../assets/fonts/Pretendard-Medium.subset.otf'),
  [fontFamilies.sans600]: require('../../assets/fonts/Pretendard-SemiBold.subset.otf'),
  [fontFamilies.sans700]: require('../../assets/fonts/Pretendard-Bold.subset.otf'),
  [fontFamilies.sans800]: require('../../assets/fonts/Pretendard-ExtraBold.subset.otf'),
};
