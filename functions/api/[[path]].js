// /api/* 를 Render 의 API 로 넘긴다.
//
// 프록시를 두면 브라우저가 출처를 하나만 본다. 그래서 CORS 설정도, 프론트 안의
// API 주소 분기도 필요 없다 — web/src/useSnapshot.ts 는 location.host 를 그대로 쓰고
// 로컬(vite proxy)과 배포가 같은 코드로 돈다.
//
// 옛 프로젝트는 세션 쿠키(SameSite) 때문에 이 프록시가 반드시 필요했다. 지금은
// 인증이 없어서 그 이유는 사라졌지만, 프론트를 안 고쳐도 되는 쪽이 여전히 낫다.
//
// API_ORIGIN 은 Pages 프로젝트 환경변수로 넣는다 (예: https://moto-sensing-api.onrender.com).
// 없으면 500 을 내고, 화면은 픽스처로 넘어간다.

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.API_ORIGIN) {
    return new Response(
      JSON.stringify({ detail: "API_ORIGIN 환경변수가 없다 (Pages 프로젝트 설정)" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);

  // 메서드·헤더·본문을 그대로 넘긴다.
  const upstream = await fetch(new Request(target, request), { redirect: "manual" });

  // Response 를 새로 만들면 헤더를 손볼 수 있으면서 스트림은 그대로 흘러간다.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
