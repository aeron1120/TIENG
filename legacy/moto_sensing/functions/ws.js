// /ws 를 Render 로 넘긴다. 스냅샷이 이 통로로 10Hz 로 밀려온다 (api/ws.py).
//
// 업그레이드는 요청을 그대로 넘기면 성립한다. 워커가 101 응답을 받으면 그 소켓을
// 그대로 돌려준다 — 여기서 헤더를 다시 만들면 Sec-WebSocket-Accept 가 깨진다.
//
// Render free 플랜이 잠들어 있으면 첫 연결이 30초쯤 걸리거나 실패한다. 그때는
// 화면이 픽스처로 넘어갔다가, 재연결 백오프가 돌면서 깨어난 뒤 붙는다
// (web/src/useSnapshot.ts).

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.API_ORIGIN) {
    return new Response("API_ORIGIN 환경변수가 없다 (Pages 프로젝트 설정)", { status: 500 });
  }

  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("이 경로는 WebSocket 전용이다", { status: 426 });
  }

  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);
  // https -> wss. fetch 는 http(s) 스킴을 쓰고 업그레이드는 헤더로 판단한다.
  return fetch(new Request(target, request));
}
