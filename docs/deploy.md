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

## Supabase (계정)

컨테이너는 재배포·재시작마다 새로 뜬다. 계정을 `state/users.db` 에 두면 그때마다
같이 날아가서 쓸 때마다 다시 가입해야 한다. 그래서 클라우드에서는 계정만 밖에 둔다.

| 항목 | 값 |
|---|---|
| Connection Method | **Session pooler** (포트 5432) |
| Type | URI |
| 리전 | Render 와 같은 곳 (싱가포르) |

Direct connection 은 IPv6 전용이라 Render 에서 연결되지 않는다. 비밀번호에 특수문자가
있으면 퍼센트 인코딩해야 한다 (`@`→`%40`).

Render 환경변수:

| 키 | 값 |
|---|---|
| `DATABASE_URL` | 위 연결 문자열 |
| `TFV_ADMIN_USER` | 관리자 아이디 |
| `TFV_ADMIN_PASSWORD` | 관리자 비밀번호 (8자 이상) |

`DATABASE_URL` 이 없으면 지금까지처럼 파일을 쓴다. 파이는 그 값을 두지 않는다 —
LAN 안에서 인터넷 없이 돌아야 하므로 (README §1) 계정이 밖에 있으면 인터넷이 끊긴
방에서 로그인이 막힌다. 빌드도 `pip install -e ".[cloud]"` 라야 psycopg 가 깔린다.

`api/auth_pg.py` 는 스키마를 만들면서 `anon`/`authenticated` 권한을 회수하고 RLS 를
켠다. Supabase 의 Data API 가 켜져 있으면 `sessions` 가 공개 키 하나로 읽히고, 그러면
토큰을 쿠키에 넣어 관리자로 들어올 수 있다. 콘솔 체크에 기대지 않고 코드에서 닫는다.

## 관리자

`TFV_ADMIN_USER` / `TFV_ADMIN_PASSWORD` 가 있으면 앱이 뜰 때 그 계정을 관리자로
세운다. 없으면 만들고, 있으면 비밀번호를 환경변수에 맞춘다 — 잊었을 때 DB 를 손대지
않고 환경변수만 바꿔 다시 띄우면 된다.

이 계정이 있으면 그 뒤로 가입하는 사람은 전부 승인을 기다린다. 공개 주소에서 누가
먼저 가입하는지가 관리자를 정하면 안 되기 때문이다.

**둘 다 없으면 첫 가입자가 관리자가 된다.** 파이는 환경변수 없이 켜는 일이 잦고,
관리자를 아무도 만들 수 없으면 기기가 통째로 잠긴다.

## 알아둘 제약

- **free 플랜은 잠든다.** 접속이 없으면 Render 가 서비스를 재우고, 첫 요청은 30초쯤
  걸린다. 화면(Pages)은 잠들지 않으므로 화면만 먼저 뜨고 값이 늦게 붙는다.
- **Supabase 무료는 7일 미접속이면 프로젝트를 일시정지한다.** Render 와 달리 요청으로
  깨어나지 않는다 — 콘솔에서 손으로 재개해야 한다.
- **기록은 여전히 사라진다.** 개입 CSV(`logs/*.csv`)는 계정과 달리 아직 컨테이너
  안에 있다. 재배포마다 화면의 기록 탭이 비워진다.
