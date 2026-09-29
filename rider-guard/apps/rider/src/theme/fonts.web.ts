/**
 * Pretendard 글꼴 원본 — 웹은 한글 부분집합 .woff2 (public/fonts 를 그대로 서빙한다. Metro 는 woff2 를 에셋으로 모른다).
 * 원본은 assets/fonts 의 *.subset.woff2 와 같다. 라이선스: assets/fonts/Pretendard-LICENSE.txt (SIL OFL 1.1)
 */
import type { FontSource } from 'expo-font';

import { fontFamilies } from './index';

export const fontSources: Record<string, FontSource> = {
  [fontFamilies.sans400]: '/fonts/Pretendard-Regular.subset.woff2',
  [fontFamilies.sans500]: '/fonts/Pretendard-Medium.subset.woff2',
  [fontFamilies.sans600]: '/fonts/Pretendard-SemiBold.subset.woff2',
  [fontFamilies.sans700]: '/fonts/Pretendard-Bold.subset.woff2',
  [fontFamilies.sans800]: '/fonts/Pretendard-ExtraBold.subset.woff2',
};
