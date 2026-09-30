# Rider Guard 배포

## Cloudflare Pages

기존 `tieng` 프로젝트를 사용하며 운영 주소는 `https://tieng.pages.dev`입니다.

| 설정 | 값 |
| --- | --- |
| Git 저장소 | `aeron1120/TIENG` |
| 운영 브랜치 | `main` |
| 루트 디렉터리 | `rider-guard/apps/rider` |
| 빌드 명령 | `npm run build:web` |
| 빌드 결과 디렉터리 | `dist` |
| Node.js | `24` (`NODE_VERSION=24`) |
| API 주소 | `EXPO_PUBLIC_API_URL=https://rider-guard-api.onrender.com` |

Pages의 Git 빌드는 먼저 `npm ci`로 의존성을 설치합니다. 수동 빌드/배포는 다음과 같습니다.

```sh
cd rider-guard/apps/rider
npm ci
npm run build:web
npx wrangler pages deploy dist --project-name tieng --branch main
```

`build:web`는 API 주소가 없으면 위 Render 주소를 사용합니다. `public/_redirects`가
`/auth/callback`을 포함한 앱 경로를 SPA로 연결합니다. 이전 루트 `functions/` 프록시는
`legacy/moto_sensing/functions/`에 보관하며 Rider Guard 웹에서는 API를 직접 호출합니다.

## Render API와 데이터베이스

- 서비스: `rider-guard-api`
- 저장소/브랜치: `aeron1120/TIENG` / `main`
- Blueprint: `rider-guard/render.yaml`
- 루트: `rider-guard/apps/server`
- 빌드: `npm ci --omit=dev`
- 시작: `npm start`
- 상태 확인: `https://rider-guard-api.onrender.com/healthz`
- `DATABASE_URL`과 `DATABASE_AUTH_TOKEN`: 기존 Turso 값을 유지합니다. 이 값들은 저장소에 넣지 않습니다.
- `PUBLIC_BASE_URL`: `https://rider-guard-api.onrender.com` 또는 비워 두고 Render의 `RENDER_EXTERNAL_URL` 사용.

기존 Render 서비스가 `Justin` 브랜치를 보고 있다면 Settings에서 `main`으로 바꾸고
최신 커밋을 수동 배포해야 합니다. 저장소의 Blueprint 변경만으로 기존 서비스 설정이
즉시 바뀌었다고 가정하지 마세요. 환경변수와 데이터베이스는 그대로 보존합니다.

Rider Guard의 DB 드라이버는 `@libsql/client`입니다. Supabase 관련 코드는
`legacy/touchfree_vitals/`에만 있으며, 현재 로그인은 Supabase Auth를 거치지 않습니다.

## Google OAuth

Google Cloud 콘솔에서 OAuth 클라이언트 유형은 **웹 애플리케이션**을 선택합니다.
**승인된 리디렉션 URI**에는 아래 전체 주소를 넣습니다. 끝에 `/`를 추가하지 않습니다.

```text
https://rider-guard-api.onrender.com/auth/oauth/google/callback
```

Render 서비스의 Environment에는 같은 OAuth 클라이언트의 두 값을 설정합니다.

```text
GOOGLE_CLIENT_ID=<클라이언트 ID>
GOOGLE_CLIENT_SECRET=<클라이언트 보안 비밀>
```

둘 다 있어야 `GET /auth/providers`에 `google`이 표시되고 앱에서 Google 로그인 버튼이 보입니다.
보안 비밀은 Render에만 저장하며 Pages 환경변수나 `EXPO_PUBLIC_*`에 넣지 않습니다.

로그인 경로:

```text
tieng.pages.dev 또는 모바일 앱
  → Google 로그인
  → rider-guard-api.onrender.com/auth/oauth/google/callback
  → 웹: tieng.pages.dev/auth/callback
    모바일: riderguard://auth/callback
  → API에서 1회용 코드 + sessionKey를 로그인 토큰으로 교환
```

웹 복귀 주소는 서버에서 위 주소 하나만 허용합니다. 미리보기 도메인, 임의 쿼리,
외부 사이트를 허용하지 않습니다. Google 콘솔에 넣는 URI는 Render의 서버 콜백입니다.
이 서버 측 OAuth 흐름은 Google JavaScript SDK를 사용하지 않으므로 승인된 JavaScript
원본 설정은 필요하지 않습니다.

## 확인

```sh
cd rider-guard/apps/server
npm ci
npm test
npm run typecheck
npm run lint

cd ../rider
npm ci
npm run typecheck
npm run lint
npm run build:web
```

배포 후 `/`, `/auth/callback`, 앱 JavaScript와 폰트 파일이 정상 응답하는지 확인하고,
API의 `/auth/providers`와 실제 Google 로그인 화면을 확인합니다. Google 키가 아직
설정되지 않았다면 Google 인증 전체 흐름의 운영 검증은 완료되지 않은 상태입니다.
