# Rider Guard

심야 배달 라이더 사고 감지·대응 서비스. 설계 근거는 `심야배달라이더_안전시스템_설계문서` (2026-09-10).

```
design/              화면 디자인 원본 (.dc.html, 390×844)
apps/rider/          라이더 앱 — Expo (React Native, TypeScript, expo-router)
apps/server/         API 서버 — Node 24 + Hono + libSQL(로컬 파일 또는 Turso 클라우드), 빌드 단계 없음
packages/contract/   앱·서버가 함께 쓰는 API 요청/응답 타입 (타입만, 런타임 코드 없음)
```

## 실행

```bash
# 1) 서버 — http://localhost:4000, 관제 콘솔 http://localhost:4000/ops (토큰 dev-ops-token)
cd apps/server
npm install
npm run dev

# 2) 앱 — Expo Go 로 QR 스캔, 또는 w 로 웹
cd apps/rider
npm install
npm start
```

- 앱은 `EXPO_PUBLIC_API_URL` 이 없으면 Metro 를 띄운 PC 의 IP:4000 으로 붙는다. 같은 Wi-Fi 의 실기기(Expo Go)에서도 그대로 동작한다.
- 비상연락처가 문자로 받는 위치 링크는 `PUBLIC_BASE_URL` 기준이다. 휴대폰에서 열어 보려면 `apps/server/.env` 에 PC 의 IP 를 넣는다 (`.env.example` 참고).
- 개발 서버에서는 문자 대신 서버 콘솔에 `[SMS → 번호] 내용` 이 찍힌다.
- 저장소는 `DATABASE_URL` 이 없으면 `apps/server/data/rider-guard-v2.db` 파일. Turso 주소·토큰을 넣으면 클라우드 DB 를 쓴다.
- 푸시 알림·백그라운드 위치는 Expo Go 에서 안 되고 개발 빌드가 필요하다: `cd apps/rider && npm run build:android` (EAS) → 설치 후 `npx expo start --dev-client`.
  빌드 전에 Firebase 콘솔(프로젝트 설정 → Android 앱 `com.tieng.riderguard`)에서 받은 `google-services.json` 을 `apps/rider/` 에 둔다 — API 키가 들어 있어 저장소에는 올리지 않는다.

## 배포 (Render + Turso, 둘 다 무료)

같은 Wi-Fi 가 아니어도 쓰려면 서버와 DB 를 클라우드에 두고, 앱은 코드가 들어간 APK 로 만든다.

1. DB — Turso 에 데이터베이스를 만들고 주소(`libsql://…turso.io`)와 토큰을 받는다. 스키마는 서버가 처음 뜰 때 만든다.
2. 서버 — Render 대시보드 → New → Blueprint → 이 저장소, Blueprint 경로 `rider-guard/render.yaml`.
   `DATABASE_URL`·`DATABASE_AUTH_TOKEN` 은 이때 대시보드에 넣는다(저장소에 적지 않는다). `OPS_TOKEN` 은 Render 가 만들고,
   `PUBLIC_BASE_URL` 은 비워 두면 Render 주소(`https://<이름>.onrender.com`)를 쓴다. `Justin` 브랜치에 올리면 다시 배포된다.
3. 앱 — `EXPO_PUBLIC_API_URL=<Render 주소>` 로 preview 빌드(APK)를 만든다. Metro 없이 어디서나 동작한다.

- 무료 Render 는 15분 동안 요청이 없으면 잠들고, 첫 요청이 30~60초 걸린다. 운행 중에는 위치를 15초마다 보내 깨어 있다.
- Turso 는 읽은 행 수로 무료 한도를 센다 — 자주 도는 조회는 전부 인덱스를 타게 해 두었다(스키마 v3). `GET /me` 는 조회를 한 번에 묶어 보낸다.

## 데모 순서

1. 앱에서 이메일로 가입(또는 SNS 로그인) → 이름·휴대폰·동의 입력 → 설정 화면
2. 다른 터미널에서 `cd apps/server && npm run fake-detector` → 표시된 페어링 코드를 앱에 입력 (하드웨어 없이 감지 기기 흉내)
3. 비상연락처 추가 → 설정 완료 → 홈에서 **운행 시작**
4. detector 터미널에서 엔터(충격) 또는 `f`(전도) → 앱에 사고 확인 화면이 뜬다. 홈의 '개발용 · 사고 감지 테스트' 버튼도 같다.
5. **도움이 필요해요** 또는 30초 무응답 → 서버 콘솔에 비상연락 문자, 관제 콘솔(`/ops`)에 사고 접수
6. 관제 콘솔에서 배정받기 → 119 신고 → 대체배차 완료 → 종료. 앱의 상태 화면이 3초 안에 따라 바뀐다.
7. 진행 중 주문 보류·대체배차 흐름을 보려면 사고 전에 `POST /me/dev/order` 로 주문을 만든다 (개발 서버 전용).

## 로그인 · 회원가입

- 이메일 + 비밀번호(8자 이상), 카카오 · 네이버 · 구글. 가입 뒤 이름 · 휴대폰(필수, 인증 없음) · 동의를 받아야 운행을 시작할 수 있다 (`POST /me/onboarding`, 안 하면 `POST /me/session` 이 403).
- 비밀번호는 scrypt 로 저장, 5번 틀리면 15분 잠금. 가입 여부를 알려 주지 않도록 '이메일 또는 비밀번호가 맞지 않아요' 한 가지로 답한다.
- 같은 이메일이어도 로그인 수단이 다르면 다른 계정이다 (자동으로 합치지 않음 — 남의 SNS 계정으로 가로채기 방지).
- 비밀번호는 확인하기 전에 시도 횟수를 먼저 센다 — 동시에 수백 개를 보내도 잠금 창 하나에서 확인까지 가는 시도는 5번.
- 회원 탈퇴는 앱 설정에서 (Google Play 정책). 진행 중인 사고가 있으면 거부. 위치 이용 기록은 위치정보법에 따라 남기고 184일(6개월)이 지나면 스케줄러가 지운다. 카카오 회원이면 카카오 연결 끊기를 보낸다(`KAKAO_ADMIN_KEY`, 실패하면 재시도).

SNS 로그인은 서버가 인가 코드를 받는 방식이다 — 앱이 시스템 브라우저로 제공자 로그인을 열고, 제공자는 서버 콜백으로, 서버는 60초짜리 1회용 코드를 붙여 앱(`riderguard://auth/callback`)으로 돌려보낸다. 시크릿은 서버에만 있다.
1회용 코드는 로그인을 시작할 때 서버가 앱에만 준 `sessionKey` 가 있어야 토큰으로 바뀐다(PKCE 와 같은 역할) — 같은 스킴을 가로챈 다른 앱이나 남의 코드를 심은 링크로는 로그인되지 않는다. 앱은 이 키를 보안 저장소에 두므로, 로그인 중 안드로이드가 앱을 정리해도 돌아와서 마칠 수 있다.

켜는 법: 제공자 콘솔에서 앱을 만들고 콜백 주소 `<PUBLIC_BASE_URL>/auth/oauth/<kakao|naver|google>/callback` 을 등록한 뒤, 키를 `apps/server/.env` 에 넣는다 (`.env.example` 참고). 두 값이 다 있는 제공자만 앱에 버튼이 보인다.

| 제공자 | 콘솔 | 주의 |
| --- | --- | --- |
| 카카오 | developers.kakao.com → 카카오 로그인 활성화, Redirect URI, 보안 > Client Secret, 앱 키 > Admin 키 | 이메일·전화번호는 비즈 앱이어야 받을 수 있다 (없으면 가입 정보에서 직접 입력) |
| 네이버 | developers.naver.com → 애플리케이션 등록(네이버 로그인), Callback URL | 검수 전에는 '멤버 관리'에 등록한 아이디만 로그인된다 |
| 구글 | console.cloud.google.com → OAuth 동의 화면, OAuth 클라이언트 ID(웹 애플리케이션) | 콜백이 https 여야 한다(localhost 제외) — PC IP 로는 안 되고 클라우드 서버가 필요. 테스트 모드면 테스트 사용자만 |

## 지표 백엔드 연결

지표를 계산하는 쪽(지금은 MuJoCo 시뮬레이션, 나중에는 태그·moto-sensing)은 **지표만 보내면** 된다. 판정·기록·경보·에스컬레이션은 이 서버가 한다.

1. 한 번만: `POST /device-api/register {"name":"…","kind":"tag"}` → 받은 페어링 코드를 앱 설정의 '기기 연결'에 입력
2. 매번: `POST /device-api/indicators` (헤더 `Authorization: Device <deviceToken>`)

```json
{
  "indicators": [
    { "key": "delta_v",      "value": 7.4,  "unit": "m/s",   "state": "ok", "sqi": null, "t": 4.0 },
    { "key": "tilt_deg",     "value": 84,   "unit": "deg",   "state": "ok", "sqi": null, "t": 4.0 },
    { "key": "speed",        "value": 0.1,  "unit": "m/s",   "state": "ok", "sqi": null, "t": 4.0 },
    { "key": "accel_var_1s", "value": 0.04, "unit": "m/s^2", "state": "ok", "sqi": null, "t": 4.0 }
  ],
  "mode": "live",
  "reportId": "세션id:이벤트id",
  "producer": "tag-v1"
}
```

- 지표 한 칸의 모양은 moto-sensing `core/schemas.py` 의 `Indicator` 와 같다. moto-sensing `Snapshot` 을 그대로 보내도 읽힌다.
- 판정 (설계문서 5.1): 충격(`delta_v` ≥ 3.33 m/s) 또는 전도(`tilt_deg` ≥ 60°) → 사후 무동작(`speed` ≤ 0.83 m/s, `accel_var_1s` ≤ 0.3) → 경보. 충격 뒤 움직이면 기각, 무동작을 못 재면(값 없음·품질 미달) 놓치지 않도록 경보. 임계값은 전부 추정치라 `.env` 로 바꾼다.
- 값이 없으면 `value: null` + `state: "low_quality"` 로 보낸다. 0 으로 메우면 가만히 있는 것으로 읽힌다. 단위가 다르면 판정에 쓰지 않는다.
- 응답에 판정(`alarm`/`alarm_unverified`/`reject`/`undetermined`)과 규칙별 실측값·임계값(`traces`)이 온다. `"dryRun": true` 면 판정만 받고 아무것도 남기지 않는다.
- 판정은 경보가 아니어도 전부 기록된다 (`GET /ops/api/judgments`). 사고를 연 판정의 근거는 관제 콘솔 사고 상세에 보인다.
- `mode` 가 `simulated`/`replay` 면 개발 서버에서는 테스트 사고로 열리고, 운영 서버에서는 기록만 한다. `DETECTION_ENABLED=false`(Phase 1)면 경보여도 기록만 한다.
- 태그 → 휴대폰 → 서버 경로는 같은 본문을 `POST /me/indicators` (라이더 토큰)로 보낸다.

시뮬레이션 결과로 확인하기:

```bash
cd apps/server
npm run sim -- ../../../results/1_lowside.csv ../../../results/2_frontal.csv --dry-run   # 판정만
npm run sim -- ../../../results/2_frontal.csv                                           # 페어링 후 실제 경보까지
```

`results/*.csv` 의 열(t, ax…gz, vx…vz, com_v*, tilt_deg)에서 실행보고서 5절 정의대로 지표를 계산해 보낸다 (`scripts/sim-indicators.ts`).

## 설계문서 → 구현

| 설계문서 | 구현 |
| --- | --- |
| 2.1, 9.4 근무 세션 외 수집 중단 | 운행 세션이 없으면 사고 감지·위치 업로드를 서버가 거부. 앱도 세션 동안만 위치 수집 |
| 4.1.1 운행 시작/종료, 자동 만료 | `POST /me/session`, `/me/session/end`, 12시간 뒤 자동 종료 |
| 4.1.2 공유 대상 분리 권한 | 연락처별 공개 범위: 운행 중 항상 / 사고 감지 시 / 사고 확정 시. 관제는 확정된 사고만 조회 |
| 4.1.4 오프라인 버퍼링 | 앱이 전송 실패분을 모았다가 재전송, 서버는 세션 기간 안의 점이면 늦게 와도 받음 |
| 4.3 에스컬레이션 1~4단계 | 카운트다운(30~60초) → 1순위부터 위치 링크 문자(앞 순위가 확인하면 중단) → 관제 접수 → 상담원 판단으로 119 |
| 4.3 신고 문자 항목 | 위치·지도 링크, 차량 정보, 의료정보(별도 동의 시)로 신고문 생성 |
| 5.7 ±5초 원시 센서 로그 | `PUT /me/incidents/:id/sensor-log` 로 보관 (1MB) |
| 6.4 괜찮음은 사람이 판단 | 에스컬레이션 뒤의 '괜찮아요'는 사고를 닫지 않고 기록만, 종료는 상담원이 결정 |
| 9.1 이용내역 통보 | 연락처·관제가 위치를 볼 때마다 기록, `GET /me/location-access` |
| 9.3 생체·의료정보 별도 동의 | `medicalInfo` 동의 없이는 저장 거부, 철회 시 삭제 |
| 10장 Phase 2 | 119 자동 문자는 기본 꺼짐(`ENABLE_119_SMS=false`) — 상담원에게 신고문만 제공 |

## 화면 ↔ 디자인

| 라우트 | 디자인 | 이동 |
| --- | --- | --- |
| `/` | `Main.dc.html` 을 로그인으로 변경 (SNS · 이메일) | 로그인 → 가입 정보를 마쳤으면 `/home`, 아니면 `/onboarding`. 가입하기 → `/signup` |
| `/signup` | (디자인 없음) 이메일 가입 | 가입하기 → `/` 를 거쳐 `/onboarding` |
| `/onboarding` | `Main.dc.html` 의 동의 항목 | 처음: 동의하고 시작하기 → `/setup`. 설정에서 수정(`?mode=edit`): 저장 → `/settings` |
| `/auth/callback` | — | SNS 로그인 뒤 돌아오는 딥링크. 로그인 처리 후 `/` |
| `/setup` | `Setup.dc.html` 기기 연결과 비상연락망 | 뒤로 → 이전 화면, 연락처 추가/편집 → `/contact`, 설정 완료 → `/home` |
| `/contact` | (디자인 없음) 비상연락처 추가·편집 | 저장·삭제 → `/setup` |
| `/home` | `Home.dc.html` 홈 운행 중 (+ 운행 전 상태) | 수정 → `/setup`, 하단 탭 |
| `/records` | `Records.dc.html` 사고 기록 | 기록 → `/status` |
| `/alert` | `Alert.dc.html` 사고 확인 | 사고 감지 시 어느 화면에서든 자동으로 뜸. 도움이 필요해요 → `/status`, 괜찮아요 → `/home` |
| `/status` | `Status.dc.html` 사고 대응 진행 상황 | 119 / 관제센터 전화, 닫기 → `/home` |
| `/settings` | (디자인 없음) 계정 · 알림 상태 · 로그아웃 · 회원 탈퇴 | 가입 정보 수정 → `/onboarding?mode=edit` |

하단 탭: 홈 · 기록 · 연락망(`/setup`) · 설정(`/settings`).

## 코드 구조

`apps/rider/src`
- `theme/` — 색상·폰트·radius 공통 토큰. 화면 코드에 hex 값을 직접 쓰지 않는다.
- `components/` — `ui.tsx`(Screen, Button, Card, Badge, Txt), `forms.tsx`(입력칸, 체크박스, SNS 버튼), `Icons.tsx`, `BottomNav.tsx`
- `api/` — `client.ts`(주소·토큰·오류), `hooks.ts`(React Query 조회/변경)
- `auth/` — `AuthProvider.tsx`(토큰 보관: 네이티브 SecureStore, 웹 localStorage. 401 이면 로그인으로, 로그아웃하면 서버에서도 토큰 폐기), `AfterSignIn.tsx`(로그인 뒤 홈/가입 정보 분기)
- `features/` — `socialLogin.ts`(SNS 로그인), `push.ts`(푸시 등록), `location.ts`(운행 중 백그라운드 위치), `SessionServices.tsx`(사고 감지 시 확인 화면·알림 응답)
- `lib/format.ts` — 서버 상태 → 화면 문구

`apps/server/src`
- `db.ts` — libSQL 연결, 스키마 버전 관리, 트랜잭션
- `services/auth.ts` · `password.ts` · `oauth.ts` · `social.ts` · `account.ts` — 이메일 가입/로그인, SNS 인가 코드 흐름, 탈퇴
- `services/incidents.ts` — 사고 상태 기계와 에스컬레이션, `services/scheduler.ts` — 카운트다운 만료·문자 발송·세션 만료 (1초 주기, 재시작해도 DB 에서 이어서 처리)
- `services/sharing.ts` — 공유 링크 권한 판단과 위치 이용내역
- `providers.ts` — SMS · 119 · 배달대행사 연동 지점 (지금은 콘솔 출력), 푸시(Expo), SNS 제공자 API
- `routes/` — 라이더(`/auth`, `/me`), 기기(`/device-api`), 관제(`/ops`), 공유 페이지(`/s/:token`)

## 검사

```bash
cd apps/server && npm test && npm run typecheck && npm run lint   # 가입·SNS·에스컬레이션·권한·기기·지표 판정 64개
cd apps/rider && npm run typecheck && npm run lint
```

## 아직 없는 것

- 실제 SMS 사업자·119 문자신고·배달대행사 API 연동 (인터페이스만 있음), 주소 변환(역지오코딩)
- 개발용 주문 만들기(`POST /me/dev/order`)는 운영 서버에서 꺼진다 — 대체배차 흐름은 로컬 서버에서 시연
- 휴대폰 번호 인증, 비밀번호 찾기·변경, 이메일 계정과 SNS 계정 합치기
- 탈퇴 시 네이버·구글 연동 해제 — 사용자 토큰을 보관하지 않아 서버에서 끊을 수 없다. 사용자가 각 계정 설정에서 끊는다
- 로그인·가입 요청 수 제한(IP 단위) — 배포할 때 프록시에서
- 경보음(진동만 구현), QR 스캔(코드 입력으로 대체), 사고기록 PDF·공유, 설정 화면 디자인
- 실제 시뮬레이션 결과로 임계값 확정 (지금 값은 설계문서·moto-sensing 설정에서 가져온 추정치)
- 신체 착용 태그의 BLE 연동, 근접 사고 자가 보고(8.3), 음성·회복 신호(5.4, 6.3.5), 개인화 임계값
- 위치정보사업 신고 등 법적 절차(9.1) — 운영 전 필수
