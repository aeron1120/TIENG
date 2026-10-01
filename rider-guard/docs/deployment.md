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
| API 주소 | `EXPO_PUBLIC_API_URL=https://rider-guard-api-ejwy.onrender.com` |

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
- 상태 확인: `https://rider-guard-api-ejwy.onrender.com/healthz`
- `DATABASE_URL`과 `DATABASE_AUTH_TOKEN`: 기존 Turso 값을 유지합니다. 이 값들은 저장소에 넣지 않습니다.
- `PUBLIC_BASE_URL`: `https://rider-guard-api-ejwy.onrender.com` 또는 비워 두고 Render의 `RENDER_EXTERNAL_URL` 사용.

기존 Render 서비스가 `Justin` 브랜치를 보고 있다면 Settings에서 `main`으로 바꾸고
최신 커밋을 수동 배포해야 합니다. 저장소의 Blueprint 변경만으로 기존 서비스 설정이
즉시 바뀌었다고 가정하지 마세요. 환경변수와 데이터베이스는 그대로 보존합니다.

Rider Guard의 DB 드라이버는 `@libsql/client`입니다. Supabase 관련 코드는
`legacy/touchfree_vitals/`에만 있으며, 현재 로그인은 Supabase Auth를 거치지 않습니다.

## 카카오 지도 (웹)

키가 있으면 웹의 지도 카드(홈·긴급 알림 웹)가 카카오 지도로 뜬다. 키가 없거나, 도메인이 등록되지 않았거나,
12초 안에 타일이 오지 않으면 기존 지도(MapLibre + OpenFreeMap)로 자동으로 돌아간다. 안드로이드 앱은
웹뷰가 `file://`로 열려 도메인을 등록할 수 없으므로 계속 기존 지도를 쓴다(`components/map/KakaoMapCanvas.tsx`).

1. [카카오 개발자](https://developers.kakao.com) → 내 애플리케이션 → 앱 만들기(또는 기존 앱).
2. 앱 설정 → 플랫폼 → **Web 사이트 도메인**에 등록:

   ```text
   https://tieng.pages.dev
   https://rider-guard.expo.app
   http://localhost:8081        (로컬 개발 때만)
   ```

3. 제품 설정에서 **카카오맵** 사용을 켠다(콘솔에 해당 메뉴가 있으면).
4. 앱 키 중 **JavaScript 키**는 `apps/rider/scripts/build-web.mjs`의 기본값으로 들어 있다(공개값, 등록 도메인에서만 동작). (Pages 대시보드 변수를 넣었는데도 번들에 빈 값이 남았던 원인은 빌드 캐시로 보여 `build:web`이 매번 `--clear`로 캐시를 비운다.) 키를 바꿀 때는 스크립트 기본값을 고치거나 빌드 환경에 다음을 준다:

   ```text
   EXPO_PUBLIC_KAKAO_MAP_KEY=<JavaScript 키>
   ```

   REST API 키·Admin 키가 아니다. JavaScript 키는 번들에 공개되는 값이고 등록 도메인으로 보호된다. Render에는 넣지 않는다.
5. 빌드 때 번들에 들어가므로 변수를 넣은 뒤 Pages에서 **다시 배포**(Deployments → Retry)해야 반영된다.
   로컬은 `apps/rider/.env`(Git 제외)에 같은 줄을 넣고 `npx expo start --web`.

지도 오른쪽 아래의 카카오 로고·저작권 표시는 약관상 가리면 안 된다. 왼쪽 아래는 앱 알약 자리라 SDK 표시를 오른쪽으로 옮겼다.

## 역할과 관리자

첫 로그인 때 **배달기사 / 관제사**를 고른다(`PUT /me/role`, 설정에서 바꿀 수 있음). 배달기사는 보호·기록·설정, 관제사는 `/control`(넓은 화면)을 쓴다.
관제사는 `/control`에서 배달대행사를 등록하면 6자리 **라이더 가입 코드**를 받는다(같은 대행사의 다른 관제사는 그 코드로 합류).
배달기사는 가입 2/2단계(또는 설정 → 소속 배달대행사)에서 일하는 플랫폼(배민·쿠팡이츠·요기요·땡겨요)과 그 코드를 넣는다 — 소속 = 보호 중 위치·사고를 그 대행사 관제에 보이는 데 동의.
관제 화면은 소속 라이더의 보호 상태·위치(보호 중일 때만, 볼 때마다 위치 이용 기록)·사고를 5초마다 보여 주고, 관제사가 주문을 배정·접수·대체 배차·대응 완료한다.
사고가 에스컬레이션되면 그 라이더의 배달 중 주문이 보류된다(대행사 주문은 외부 배차 요청을 보내지 않고 관제사가 넘긴다). 가족 비상연락처는 선택이다.

관리자는 Render Environment 의 `ADMIN_EMAILS`(쉼표로 여러 개)로 정한다.

```text
ADMIN_EMAILS=admin@example.com,ops@example.com
```

Google·카카오 등 SNS 로그인에서 **제공자가 인증한 이메일**이 목록에 있으면 관리자다. 이메일 가입은 메일 인증이 없어 같은 주소여도 관리자가 되지 않는다.
관리자는 로그인하면 `/admin`으로 가고, 배달기사·관제사·통합 시연·실험 결과 화면과 실제 운영 현황(`GET /me/admin/overview`, 읽기 전용)을 본다.

## Google OAuth

Google Cloud 콘솔에서 OAuth 클라이언트 유형은 **웹 애플리케이션**을 선택합니다.
**승인된 리디렉션 URI**에는 아래 전체 주소를 넣습니다. 끝에 `/`를 추가하지 않습니다.

```text
https://rider-guard-api-ejwy.onrender.com/auth/oauth/google/callback
http://localhost:4000/auth/oauth/google/callback   (로컬 서버로 시험할 때만)
```

로컬 주소는 `npm run dev`(apps/server, 기본 포트 4000)로 Google 로그인을 시험할 때만 필요합니다.
로컬 서버에는 `apps/server/.env`(Git 제외)에 같은 두 값을 넣습니다.

Render 서비스의 Environment에는 같은 OAuth 클라이언트의 두 값을 설정합니다.

```text
GOOGLE_CLIENT_ID=<클라이언트 ID>
GOOGLE_CLIENT_SECRET=<클라이언트 보안 비밀>
```

둘 다 있어야 `GET /auth/providers`에 `google`이 표시되고 앱에서 Google 로그인 버튼이 보입니다.
보안 비밀은 Render에만 저장하며 Pages 환경변수나 `EXPO_PUBLIC_*`에 넣지 않습니다.

로그인 경로:

```text
rider-guard.expo.app · tieng.pages.dev 또는 모바일 앱
  → Google 로그인 (전체 페이지 이동, 팝업 없음)
  → rider-guard-api-ejwy.onrender.com/auth/oauth/google/callback
     (서버가 state·PKCE(S256)·nonce 확인 후 code 교환, ID token 서명·aud·iss·exp 검증, sub로 계정 식별)
  → 웹: rider-guard.expo.app/auth/callback 또는 tieng.pages.dev/auth/callback
    모바일: riderguard://auth/callback
    로컬 개발(운영 아님): http://localhost:8081/auth/callback
  → API에서 1회용 코드 + sessionKey를 로그인 토큰으로 교환
```

웹 복귀 주소는 서버에서 위 두 운영 주소만 정확히 허용합니다(`services/oauth.ts`). 미리보기 도메인, 임의 쿼리,
외부 사이트를 허용하지 않습니다. 앱 복귀 주소는 Google 콘솔에 넣지 않습니다(Google은 Render 콜백만 압니다). Google 콘솔에 넣는 URI는 Render의 서버 콜백입니다.
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
