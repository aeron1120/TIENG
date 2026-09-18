// /api/* 를 Render 의 API 로 넘긴다.
//
// 프록시를 두는 이유는 브라우저가 출처를 하나만 보게 하기 위해서다. 화면(Pages)과
// API(Render)를 다른 출처로 두면 세션 쿠키가 안 실린다 — api/routes/auth.py 가
// SameSite=Lax 로 굽는데 Lax 는 교차 출처 요청에 안 붙는다. None 으로 바꾸면
// Secure 가 강제되고, 그러면 HTTP 로 여는 파이의 LAN 화면이 로그인 불가가 된다.
// 같은 출처로 묶으면 그 분기가 통째로 사라지고 화면 코드도 그대로 쓴다.
//
// API_ORIGIN 은 Pages 프로젝트 환경변수로 넣는다 (예: https://tieng-api.onrender.com).

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

  // 메서드·헤더·본문을 그대로 넘긴다. 쿠키도 여기 포함된다.
  // redirect: "manual" 로 두는 이유는 Set-Cookie 가 붙은 응답을 워커가 대신
  // 따라가 버리면 브라우저가 쿠키를 못 받기 때문이다.
  const upstream = await fetch(new Request(target, request), { redirect: "manual" });

  // 미리보기(multipart/x-mixed-replace)는 끝나지 않는 스트림이라 본문을 그대로
  // 흘려보내야 한다. Response 를 새로 만들면 헤더를 손볼 수 있으면서 스트림은 유지된다.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
