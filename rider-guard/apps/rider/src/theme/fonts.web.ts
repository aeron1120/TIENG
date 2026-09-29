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

/**
 * 웹은 글자 스타일에 fontWeight 도 준다(theme font — 대체 글꼴의 굵기용). expo-font 가 등록하는 @font-face 는 굵기 표시가 없어(보통 400)
 * 'Pretendard-Bold' + 700 이면 브라우저가 가짜 볼드를 덧씌운다. 같은 파일을 굵기 범위 100~900 으로 한 번 더 등록해 그대로 쓰게 한다.
 */
if (typeof document !== 'undefined') {
  const css = Object.entries(fontSources)
    .map(([family, src]) => `@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(src)}) format("woff2");font-weight:100 900;font-display:swap}`)
    .join('');
  const style = document.createElement('style');
  style.setAttribute('data-rider-guard-fonts', '');
  style.textContent = css;
  document.head.appendChild(style);
}
