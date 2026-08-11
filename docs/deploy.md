# 데모 배포

파이가 켜져 있어야만 화면을 볼 수 있는 게 불편해서 만든 것이다. **여기 올라가는 값은
전부 합성이다** — 실제 방의 지표는 파이에 있고 밖으로 나오지 않는다 (README §1).
화면 뱃지가 `시뮬레이션` 으로 뜨는지 확인할 것. `실측` 으로 뜨면 구성이 잘못된 것이다.

실제 기기 배포는 이 문서가 아니라 `deploy/tfv.service` 다.

```
브라우저
   │
   ▼
Cloudflare Pages          화면(web/dist) + /api·/ws 프록시
   │  functions/
   ▼
Render                    FastAPI, DEVICE_CONFIG=config/device.mock.yaml
```

## 왜 프록시를 두는가

화면과 API 를 **다른 출처**로 두면 세션이 깨진다. `api/routes/auth.py` 가 쿠키를
`SameSite=Lax` 로 굽는데 Lax 는 교차 출처 요청에 실리지 않는다. `None` 으로 바꾸면
`Secure` 가 강제되고, 그러면 **HTTP 로 여는 파이의 LAN 화면이 로그인 불가**가 된다
(같은 파일에 그 이유가 적혀 있다). WebSocket 도 핸드셰이크에서 쿠키를 보므로
(`api/ws.py`) 같은 문제를 겪는다.

Pages 함수로 `/api` 와 `/ws` 를 넘기면 브라우저는 출처를 하나만 본다. CORS 설정도,
쿠키 정책 분기도, 화면 코드 수정도 필요 없다.

## Render (API)

저장소를 연결하면 `render.yaml` 대로 만들어진다. 수동으로 만들 때는:

| 항목 | 값 |
|---|---|
| Runtime | Python |
| Build Command | `pip install -e .` |
| Start Command | `uvicorn api.main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/auth/me` |
| 환경변수 | `DEVICE_CONFIG=config/device.mock.yaml`, `PYTHON_VERSION=3.13` |

`-e` 로 까는 이유는 `pyproject.toml` 의 `packages` 에 `actuators` 가 없어서 일반
설치로는 `tuya_plug` / `notify_email` 을 못 찾기 때문이다.

헬스체크는 세션 없이도 200 을 주는 경로여야 한다. 인증을 요구하는 경로를 걸면
Render 가 계속 죽은 것으로 보고 재시작한다.

배포되면 URL 을 적어 둔다 (`https://<이름>.onrender.com`). 다음 단계에서 쓴다.

## Cloudflare Pages (화면 + 프록시)

| 항목 | 값 |
|---|---|
| Root directory | (저장소 루트 그대로) |
| Build command | `cd web && npm ci && npm run build` |
| Build output directory | `web/dist` |
| 환경변수 | `API_ORIGIN` = 위 Render URL |

`functions/` 는 저장소 루트에 있어야 Pages 가 집어 간다. 빌드 산출물은 `web/dist`
지만 함수는 루트 기준이라 둘의 위치가 다르다.

`API_ORIGIN` 을 빼먹으면 화면은 뜨는데 모든 API 가 500 을 준다 — 함수가 그렇게
말해 주도록 해 뒀다.

## 알아둘 제약

- **free 플랜은 잠든다.** 접속이 없으면 Render 가 서비스를 재우고, 첫 요청은 30초쯤
  걸린다. 화면(Pages)은 잠들지 않으므로 화면만 먼저 뜨고 값이 늦게 붙는다.
- **계정과 기록이 사라진다.** `state/users.db` 와 개입 CSV 가 컨테이너와 함께
  날아간다. 재배포·재시작마다 다시 가입해야 한다 — 이걸 없애려면 계정을 Supabase 로
  옮겨야 한다.
- 첫 가입자가 관리자가 된다. 공개 URL 이라면 누가 먼저 가입하는지가 곧 관리자다.
