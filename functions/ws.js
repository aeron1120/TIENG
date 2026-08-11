// /ws 를 Render 로 넘긴다. 스냅샷이 이 통로로 1초마다 밀려온다 (api/ws.py).
//
// /api 프록시와 같은 이유로 여기도 같은 출처를 유지해야 한다. WebSocket 도 쿠키를
// 실어 보내고 SameSite 규칙을 똑같이 받으므로, 출처가 갈리면 세션 확인이 실패한다
// (api/ws.py 가 핸드셰이크에서 쿠키를 본다).
//
// 업그레이드는 요청을 그대로 넘기면 성립한다. 워커가 101 응답을 받으면 그 소켓을
// 그대로 돌려준다 — 여기서 헤더를 다시 만들면 Sec-WebSocket-Accept 가 깨진다.

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
