import { router, type Href } from 'expo-router';

/** 스택을 비우고 href 를 루트로 만든다. (온보딩 완료, 사고 화면 종료 등 뒤로가기로 돌아가면 안 되는 이동) */
export function resetTo(href: Href) {
  if (router.canDismiss()) router.dismissAll();
  router.replace(href);
}

/** 뒤로 갈 곳이 없으면(딥링크로 진입 등) fallback 으로 이동한다. */
export function backOr(fallback: Href) {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
