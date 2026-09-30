# Rider Guard

심야 배달 라이더 사고 감지·대응 서비스. 설계 근거는 `심야배달라이더_안전시스템_설계문서` (2026-09-10).

**관제 상담원 없는 구조다.** 사고인지 아닌지는 지표 백엔드가 판정하고, 그 뒤의 대응(비상연락 문자, 119 신고, 주문 보류·대체배차, 사고 종료)은
서버가 전부 자동으로 한다. 설계문서 6.4 의 '상담원 최종 관문'은 따르지 않는다 — 그 자리는 라이더의 취소 카운트다운과 본인 응답이 맡는다.

```
design/              화면 디자인 원본 (.dc.html, 390×844)
apps/rider/          라이더 앱 — Expo (React Native, TypeScript, expo-router)
apps/server/         API 서버 — Node 24 + Hono + libSQL(로컬 파일 또는 Turso 클라우드), 빌드 단계 없음
packages/contract/   앱·서버가 함께 쓰는 API 요청/응답 타입 (타입만, 런타임 코드 없음)
```

## 실행

```bash
# 1) 서버 — http://localhost:4000, 운영 모니터(읽기 전용) http://localhost:4000/ops (토큰 dev-ops-token)
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

웹 앱은 Cloudflare Pages의 https://tieng.pages.dev 에 배포한다.
Pages 빌드와 Google OAuth 설정은 [배포 안내](docs/deployment.md)를 참고한다.

같은 Wi-Fi 가 아니어도 쓰려면 서버와 DB 를 클라우드에 두고, 앱은 코드가 들어간 APK 로 만든다.

1. DB — Turso 에 데이터베이스를 만들고 주소(`libsql://…turso.io`)와 토큰을 받는다. 스키마는 서버가 처음 뜰 때 만든다.
2. 서버 — Render 대시보드 → New → Blueprint → 이 저장소, Blueprint 경로 `rider-guard/render.yaml`.
   `DATABASE_URL`·`DATABASE_AUTH_TOKEN` 은 이때 대시보드에 넣는다(저장소에 적지 않는다). `OPS_TOKEN` 은 Render 가 만들고,
   `PUBLIC_BASE_URL` 은 비워 두면 Render 주소(`https://<이름>.onrender.com`)를 쓴다. 배포 브랜치는 `main`이다.
3. 앱 — `cd apps/rider && npm run build:android:preview` — `eas.json` preview 프로필의 `EXPO_PUBLIC_API_URL`(Render 주소)이
   들어간 APK 를 만든다. Metro 없이 어디서나 동작한다. 개발 빌드와 패키지 이름이 같아 설치하면 개발 빌드를 대신한다.
   시연용이라 `EXPO_PUBLIC_SHOW_DEV_TOOLS` 로 홈의 '개발용 · 사고 감지 테스트' 버튼을 켜 둔다 (production 프로필에는 없음).

지금 배포된 서버: `https://rider-guard-api.onrender.com` (운영 모니터 `/ops`, 토큰은 Render 대시보드의 `OPS_TOKEN`).
운영 모니터는 읽기 전용이다 — 자동 대응이 어디까지 갔는지와 판정 근거만 보고, 위치·전화번호·의료정보는 보이지 않는다.
토큰 칸은 서버가 `OPS_TOKEN` 없이 떴을 때(로컬)만 미리 채워진다.
기존 서비스가 `Justin`을 보고 있다면 Render Settings에서 `main`으로 바꾼다.
공개 저장소 주소로 연결한 서비스는 자동 배포되지 않을 수 있으므로 Render에서 Manual Deploy로 최신 커밋을 배포한다.

- 무료 Render 는 15분 동안 요청이 없으면 잠들고, 첫 요청이 30~60초 걸린다. 운행 중에는 위치를 15초마다 보내 깨어 있다.
- Turso 는 읽은 행 수로 무료 한도를 센다 — 자주 도는 조회는 전부 인덱스를 타게 해 두었다(스키마 v3). `GET /me` 는 조회를 한 번에 묶어 보낸다.

## 데모 순서

1. 앱에서 이메일로 가입(또는 SNS 로그인) → 이름·휴대폰·동의 입력 → 설정 화면
2. 다른 터미널에서 `cd apps/server && npm run fake-detector` → 표시된 페어링 코드를 앱에 입력 (하드웨어 없이 감지 기기 흉내)
3. 비상연락처 추가 → 설정 완료 → 홈에서 **운행 시작**
4. detector 터미널에서 엔터(충격) 또는 `f`(전도) → 앱에 사고 확인 화면이 뜬다. 홈의 '개발용 · 사고 감지 테스트' 버튼도 같다.
5. **도움이 필요해요** 또는 30초 무응답 → 서버 콘솔에 비상연락 문자와 `[119 문자신고]` 가 곧바로 찍히고, 진행 중 주문은 보류 → 대체배차 완료까지 자동.
   운영 모니터(`/ops`)에서 타임라인과 판정 근거를 본다.
6. 앱 상태 화면의 **괜찮아요** → 대응 마치기 → 이미 알린 연락처와 119 에 괜찮다는 문자가 가고 사고가 닫힌다. 누르지 않으면 24시간 뒤 자동으로 닫힌다.
7. 진행 중 주문 보류·대체배차 흐름을 보려면 사고 전에 `POST /me/dev/order` 로 주문을 만든다 (개발 서버 전용).

## 로그인 · 회원가입

- 이메일 + 비밀번호(8자 이상), 카카오 · 네이버 · 구글. 가입 뒤 이름 · 휴대폰(필수, 인증 없음) · 동의를 받아야 운행을 시작할 수 있다 (`POST /me/onboarding`, 안 하면 `POST /me/session` 이 403).
- 비밀번호는 scrypt 로 저장, 5번 틀리면 15분 잠금. 가입 여부를 알려 주지 않도록 '이메일 또는 비밀번호가 맞지 않아요' 한 가지로 답한다.
- 같은 이메일이어도 로그인 수단이 다르면 다른 계정이다 (자동으로 합치지 않음 — 남의 SNS 계정으로 가로채기 방지).
- 비밀번호는 확인하기 전에 시도 횟수를 먼저 센다 — 동시에 수백 개를 보내도 잠금 창 하나에서 확인까지 가는 시도는 5번.
- 회원 탈퇴는 앱 설정에서 (Google Play 정책). 진행 중인 사고가 있으면 거부. 위치 이용 기록은 위치정보법에 따라 남기고 184일(6개월)이 지나면 스케줄러가 지운다. 카카오 회원이면 카카오 연결 끊기를 보낸다(`KAKAO_ADMIN_KEY`, 실패하면 재시도).

SNS 로그인은 서버가 인가 코드를 받는 방식이다 — 앱이 시스템 브라우저로 제공자 로그인을 열고, 제공자는 서버 콜백으로, 서버는 60초짜리 1회용 코드를 붙여 모바일 앱(`riderguard://auth/callback`) 또는 웹(`https://tieng.pages.dev/auth/callback`)으로 돌려보낸다. 시크릿은 서버에만 있다.
1회용 코드는 로그인을 시작할 때 서버가 앱에만 준 `sessionKey` 가 있어야 토큰으로 바뀐다(PKCE 와 같은 역할) — 같은 스킴을 가로챈 다른 앱이나 남의 코드를 심은 링크로는 로그인되지 않는다. 앱은 이 키를 보안 저장소에 두므로, 로그인 중 안드로이드가 앱을 정리해도 돌아와서 마칠 수 있다.

켜는 법: 제공자 콘솔에서 앱을 만들고 콜백 주소 `<PUBLIC_BASE_URL>/auth/oauth/<kakao|naver|google>/callback` 을 등록한 뒤, 키를 `apps/server/.env` 에 넣는다 (`.env.example` 참고). 두 값이 다 있는 제공자만 앱에 버튼이 보인다.

| 제공자 | 콘솔 | 주의 |
| --- | --- | --- |
| 카카오 | developers.kakao.com → 카카오 로그인 활성화, Redirect URI, 보안 > Client Secret, 앱 키 > Admin 키 | 이메일·전화번호는 비즈 앱이어야 받을 수 있다 (없으면 가입 정보에서 직접 입력) |
| 네이버 | developers.naver.com → 애플리케이션 등록(네이버 로그인), Callback URL | 검수 전에는 '멤버 관리'에 등록한 아이디만 로그인된다 |
| 구글 | console.cloud.google.com → OAuth 동의 화면, OAuth 클라이언트 ID(웹 애플리케이션) | 콜백이 https 여야 한다(localhost 제외) — PC IP 로는 안 되고 클라우드 서버가 필요. 테스트 모드면 테스트 사용자만 |

## 지표 라우터 연동 (`POST /v1/detections`)

지표팀 연동 명세(2026-09-29)의 계약이다. **판정은 지표 라우터(파이썬, 지표팀)가 하고 서버는 판정하지 않는다** — 후보 여부를 뒤집지 않고,
`fired` 를 다시 계산하지 않고, 조건 이름·기준값·규칙 문장도 서버 코드에 없다. 받은 본문을 그대로 남기고 운영 모니터가 `evidence` 를 받은 순서대로 그린다.
지표팀이 조건을 바꿔도 서버를 고치지 않는다. 스키마 원본은 지표팀 계약 묶음의 `schemas/detection.v1.schema.json`, 서버 쪽 정의는 `apps/server/src/services/detections.ts`.

- 인증 `Authorization: Bearer <INGEST_TOKEN>` (운영 모니터 토큰과 따로). 본문 64KB 이하, 모르는 필드는 422.
- 검사 순서: 인증 401 → 크기 413 → JSON 400 `invalid_json` → 스키마 422 `validation_failed`(+`details[{path,message}]`) → 라이더 422 `unknown_rider` → 중복 200/409 → 사고 201 또는 기록 200.
- 후보(`result.candidate`)면 앱의 사고로 연다 — `kind` 는 늘 `impact`, `source` 는 live → `device`, replay → `test`. 라이더 휴대폰에 사고 확인 푸시가 가고 기존 흐름(카운트다운 → 괜찮아요/도움 요청 → 비상연락)을 탄다. 후보가 아니면 기록만.
- 같은 `detection_id` 에 같은 본문(키 정렬 JSON 의 SHA-256)이면 첫 응답을 `duplicate: true` 로 돌려준다. 본문이 다르면 409 `detection_conflict`.
- 근거가 규칙과 어긋나면(`required` 가 다 발동 + `any_of` 하나 이상 ≠ 후보 여부) 경고 `evidence_inconsistent`. 후보면 사고는 '판정 불가' 등급으로 연다.
- 운행 중이 아닌 라이더의 후보는 기록만(`rider_not_on_duty`). 재생·테스트 사고가 열려 있으면 다음 판정이 그것을 닫고 새로 연다(시연은 한 건씩). 실제 사고가 열려 있으면 새로 열지 않는다(`open_incident_exists`).
- **`source: test`(재생 데이터·개발용 테스트 버튼) 사고와 `DEMO_MODE` 에서는 문자·119·배차 요청을 밖으로 보내지 않는다.** 흐름과 타임라인은 그대로 가고 "(데모) … 실제 발송 안 함"으로 남는다. 막는 곳은 발송 입구 한 곳(`scheduler.ts` 의 `deliver`)이다.
- 등급: 후보 → 라이더 도움 요청이면 경보, 무응답이면 `post_event` 로 서버 2차 확인(사후 무동작 ≥ `STILL_QUIET_MIN_S`, 기준 미검증) — 확인되면 경보,
  확인 불가면 '경보 (무동작 확인 불가)'(재생 데이터는 늘 여기), 움직임이 있으면 등급은 후보로 두되 대응은 그대로 에스컬레이션한다(상담원이 없으므로). 라이더 '괜찮아요'면 기각.
- `GET /v1/detections/{id}` 받은 본문과 첫 응답(디버깅), `GET /healthz` 깨우기(인증 없음), `POST /v1/demo/reset` 재생 사고·기록 삭제(데모 모드 전용, 아니면 403).
- 운영 모니터 사고 상세(`/ops/api/incidents/{id}`)의 `detection` 에 받은 본문이 들어간다 — 위치는 좌표를 빼고 출처·표시만.

**데모 모드 (`DEMO_MODE=true`)** — 데모 라이더 `demo-rider-01`(이름 '데모 라이더', 비상연락처 010-0000-0000, 의료정보 미동의)과
주문 `demo-order-0001`~`0006`(배달 중)을 서버가 뜰 때 만들고, 판정이 오면 데모 라이더의 운행을 켠다. 운영 모니터에 라이더 확인 전·기각된 사고와 '최근 수신'(사고를 열지 않은 판정 포함)이 보인다.
`DEMO_RIDER_PASSWORD` 를 넣으면 앱에서 `demo@riderguard.test` 로 로그인해 발표용 폰을 데모 라이더로 쓸 수 있다 — `send_demo --rider-id demo-rider-01` 한 가지로 폰과 운영 모니터가 이어진다.

```bash
curl https://rider-guard-api.onrender.com/healthz                                    # 발표 5분 전에 깨우기
python -m tools.send_demo --pause                                                   # 지표팀 계약 묶음 (Enter 한 번에 1건)
curl -X POST https://rider-guard-api.onrender.com/v1/demo/reset -H "Authorization: Bearer $INGEST_TOKEN"   # 리허설 뒤
```

## 지표 백엔드 연결 (서버 판정 — 예전 경로)

아래는 라우터가 생기기 전의 경로로, 서버가 헬멧 IMU 규칙으로 직접 판정한다. `fake-detector`·`sim` 스크립트가 쓰고 있어 남겨 두었다.

지표를 계산하는 쪽(지금은 헬멧 IMU MuJoCo 시뮬레이션, 나중에는 헬멧 태그)은 **지표만 보내면** 된다. 판정·기록·경보·에스컬레이션은 이 서버가 한다.

1. 한 번만: `POST /device-api/register {"name":"…","kind":"tag"}` → 받은 페어링 코드를 앱 설정의 '기기 연결'에 입력
2. 헬멧 합성 가속도가 3g 를 넘는 이벤트마다, 가장 큰 충격 시각(t_p) 30초 뒤에: `POST /device-api/indicators` (헤더 `Authorization: Device <deviceToken>`)

```json
{
  "indicators": [
    { "key": "peak_g",     "value": 23.4, "unit": "g",     "state": "ok", "sqi": null, "t": 31.5 },
    { "key": "peak_gyro",  "value": 1366, "unit": "deg/s", "state": "ok", "sqi": null, "t": 31.5 },
    { "key": "delta_v150", "value": 3.92, "unit": "m/s",   "state": "ok", "sqi": null, "t": 31.5 },
    { "key": "bank_deg",   "value": 88,   "unit": "deg",   "state": "ok", "sqi": null, "t": 31.5 },
    { "key": "quiet_s",    "value": 27.8, "unit": "s",     "state": "ok", "sqi": null, "t": 31.5 }
  ],
  "mode": "live",
  "detectedAt": "2026-09-29T22:14:03.120+09:00",
  "reportId": "세션id:이벤트id",
  "producer": "helmet-tag-v1"
}
```

- 지표 정의와 보내는 순서는 `packages/contract` 의 '보내는 쪽 규약'이 기준이다. `peak_g` 는 t_p 의 값, 나머지 셋은 t_p 앞뒤 0.5초 안의 최대값 — 기록 전체의 최대값이 아니다. `quiet_s` 는 보고 시각까지 |가속도−1g| < 0.15g, 각속도 < 30°/s 가 이어진 시간.
- 판정: 사고 후보 = 충격(`peak_g` ≥ 4g) AND (`peak_gyro` ≥ 600°/s OR `delta_v150` ≥ 3 m/s OR `bank_deg` ≥ 75°) → 사후 무동작(`quiet_s` ≥ 20초) → 경보. 후보 규칙은 헬멧 IMU 실험(2026-09-28, 시뮬레이션 337회)이 고른 값이고, 무동작 20초는 아직 어떤 데이터로도 맞추지 않았다. 실측이 0건이라 `.env` 로 바꾼다.
- 후보 뒤 움직이면 기각. 보조 조건이나 무동작을 못 재면(값 없음·품질 미달·단위 다름) 놓치지 않도록 경보(`alarm_unverified`). `peak_g` 가 없으면 판정 불가.
- 값이 없으면 `value: null` + `state: "low_quality"` 로 보낸다. 0 으로 메우면 가만히 있는 것으로 읽힌다. 단위가 다르면 판정에 쓰지 않는다 (각속도를 rad/s 로 보내면 걸러진다).
- 지표 한 칸의 모양은 moto-sensing `core/schemas.py` 의 `Indicator` 와 같다. moto-sensing `Snapshot` 을 그대로 보내도 읽힌다.
- 응답에 판정(`alarm`/`alarm_unverified`/`reject`/`undetermined`)과 규칙별 실측값·임계값(`traces`)이 온다. `"dryRun": true` 면 판정만 받고 아무것도 남기지 않는다.
- 판정은 경보가 아니어도 전부 기록된다 (`GET /ops/api/judgments`). 3g 에서 보내게 한 건 4g 근처에서 기각된 정상 충격(연석 등)도 여기 남기려는 것이다. 사고를 연 판정의 근거는 운영 모니터 사고 상세에 보인다.
- `mode` 가 `simulated`/`replay` 면 개발 서버에서는 테스트 사고로 열리고, 운영 서버에서는 기록만 한다. `DETECTION_ENABLED=false`(Phase 1)면 경보여도 기록만 한다.
- 태그 → 휴대폰 → 서버 경로는 같은 본문을 `POST /me/indicators` (라이더 토큰)로 보낸다.

시뮬레이션 결과로 확인하기:

```bash
cd apps/server
npm run sim -- <pcx125_helmet>/results_telemetry_validation/result_helmet.csv --dry-run   # 팀 telemetry.py 출력, 판정만
npm run sim -- <발표 자료>/data/runs/*/nominal_200hz.csv.gz --dry-run --brief              # 센서 프로파일 전체
npm run sim -- <발표 자료>/data/runs/A1_v00/nominal_200hz.csv.gz                          # 페어링 후 실제 경보까지
```

IMU 로 계산한 열(`imu_acc_norm_g`… 또는 `acc_norm_g`…)만 읽는다. 태그 실제 속도 같은 시뮬레이터 참조값은 탐지 입력이 아니다 (`scripts/sim-indicators.ts`).
시뮬레이션은 수 초에서 끝나 30초 무동작을 끝까지 볼 수 없으므로 사고 후보는 `alarm_unverified` 로 나온다 — 앞 단계만 실험과 비교된다.
기본 조건 29개 원시 실행에 팀 `telemetry.py`(같은 임계값)와 이 서버를 나란히 돌리면 사고 후보 여부가 29/29 같다.

## 설계문서 → 구현

| 설계문서 | 구현 |
| --- | --- |
| 2.1, 9.4 근무 세션 외 수집 중단 | 운행 세션이 없으면 사고 감지·위치 업로드를 서버가 거부. 앱도 세션 동안만 위치 수집 |
| 4.1.1 운행 시작/종료, 자동 만료 | `POST /me/session`, `/me/session/end`, 12시간 뒤 자동 종료 |
| 4.1.2 공유 대상 분리 권한 | 연락처별 공개 범위: 운행 중 항상 / 사고 감지 시 / 사고 확정 시. 운영 모니터는 확정된 사고만, 위치 없이 조회 |
| 4.1.4 오프라인 버퍼링 | 앱이 전송 실패분을 모았다가 재전송, 서버는 세션 기간 안의 점이면 늦게 와도 받음 |
| 4.3 에스컬레이션 1~4단계 | 카운트다운(30~60초) → 1순위부터 위치 링크 문자(앞 순위가 확인하면 중단) + 119 자동 신고 + 주문 보류·대체배차. 관제 접수 단계 없음 |
| 4.3 119 신고 실패 | 10초씩 늘려 가며 10번(약 7분) 재시도. 끝내 실패하면 문자를 받은 연락처에 직접 신고를 부탁하고, 앱·링크 화면에 '직접 신고' 안내 |
| 4.3 신고 문자 항목 | 위치·지도 링크, 차량 정보, 의료정보(별도 동의 시)로 신고문 생성 |
| 5.7 ±5초 원시 센서 로그 | `PUT /me/incidents/:id/sensor-log` 로 보관 (1MB) |
| 6.4 상담원 최종 관문 | **따르지 않음** (관제 없는 구조). 에스컬레이션 뒤 라이더의 '괜찮아요'가 사고를 닫고 연락처·119 에 알린다. 응답이 없으면 24시간(연락처 링크 유효 기간) 뒤 자동 종료 |
| 9.1 이용내역 통보 | 연락처가 위치를 볼 때마다 기록, `GET /me/location-access` |
| 9.3 생체·의료정보 별도 동의 | `medicalInfo` 동의 없이는 저장 거부, 철회 시 삭제 |
| 10장 로드맵 | 상담원 확인 단계(Phase 2)는 두지 않는다. 경보를 열면 119 도 자동이므로, 경보 없이 기록만 하려면 `DETECTION_ENABLED=false`(Phase 1) |

## 화면 ↔ 디자인

| 라우트 | 디자인 | 이동 |
| --- | --- | --- |
| `/` | `Main.dc.html` 을 로그인으로 변경 (SNS · 이메일) | 로그인 → 가입 정보를 마쳤으면 `/home`, 아니면 `/onboarding`. 가입하기 → `/signup` |
| `/signup` | (디자인 없음) 이메일 가입 | 가입하기 → `/` 를 거쳐 `/onboarding` |
| `/onboarding` | `Main.dc.html` 의 동의 항목 | 처음: 동의하고 시작하기 → `/setup`. 설정에서 수정(`?mode=edit`): 저장 → `/settings` |
| `/auth/callback` | — | SNS 로그인 뒤 돌아오는 딥링크. 로그인 처리 후 `/` |
| `/setup` | `Setup.dc.html` 기기 연결과 비상연락망 | 뒤로 → 이전 화면, 연락처 추가/편집 → `/contact`, 설정 완료 → `/home` |
| `/contact` | (디자인 없음) 비상연락처 추가·편집 | 저장·삭제 → `/setup` |
| `/home` | `Home.dc.html` 홈 운행 중 (+ 운행 전 상태). 알림 벨은 알림 목록 화면이 없어 뺐다 | 수정 → `/setup`, 하단 탭 |
| `/records` | `Records.dc.html` 사고 기록. 'PDF 받기' 대신 기록을 글로 공유(시스템 공유 시트) | 기록 → `/status` |
| `/alert` | `Alert.dc.html` 사고 확인 | 사고 감지 시 어느 화면에서든 자동으로 뜸. 도움이 필요해요 → `/status`, 괜찮아요 → `/home` |
| `/status` | `Status.dc.html` 사고 대응 진행 상황. '관제센터 전화'는 '괜찮아요'(대응 마치기)로 바꿨다 | 119 전화, 닫기 → `/home` |
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
- `services/incidents.ts` — 사고 상태 기계(`countdown → escalated → resolved`)와 에스컬레이션·119 신고문·종료 규칙
- `services/scheduler.ts` — 카운트다운 만료·문자와 119 신고 발송·대체배차·세션 만료 (1초 주기), 24시간 지난 사고 종료 (30초 주기). 재시작해도 DB 에서 이어서 처리
- `services/sharing.ts` — 공유 링크 권한 판단과 위치 이용내역
- `providers.ts` — SMS · 119 · 배달대행사 연동 지점 (지금은 콘솔 출력), 푸시(Expo), SNS 제공자 API
- `routes/` — 라이더(`/auth`, `/me`), 기기(`/device-api`), 운영 모니터(`/ops`, 읽기 전용), 공유 페이지(`/s/:token`)

## 검사

```bash
cd apps/server && npm test && npm run typecheck && npm run lint   # 가입·SNS·에스컬레이션·119 자동 신고·권한·기기·지표 판정·라우터 연동 계약·데모 모드·운영 모니터 84개
cd apps/rider && npm run typecheck && npm run lint
```

## 아직 없는 것

- 실제 SMS 사업자·119 문자신고·배달대행사 API 연동 (인터페이스만 있음), 주소 변환(역지오코딩).
  **119 자동 신고는 지금 서버 콘솔에만 찍힌다** — 연동 전에는 실제로 아무 데도 신고되지 않는다. 대체배차 '완료'도 콘솔 대행사가 받아 준 것으로 친다
- 개발용 주문 만들기(`POST /me/dev/order`)는 운영 서버에서 꺼진다 — 대체배차 흐름은 로컬 서버에서 시연
- 휴대폰 번호 인증, 비밀번호 찾기·변경, 이메일 계정과 SNS 계정 합치기
- 탈퇴 시 네이버·구글 연동 해제 — 사용자 토큰을 보관하지 않아 서버에서 끊을 수 없다. 사용자가 각 계정 설정에서 끊는다
- 로그인·가입 요청 수 제한(IP 단위) — 배포할 때 프록시에서
- 경보음(진동만 구현), QR 스캔(코드 입력으로 대체), 사고기록 PDF(지금은 글로 공유), 알림 목록 화면, 설정 화면 디자인
- 실측으로 임계값 확정 (사고 후보 값은 헬멧 IMU 시뮬레이션에서만 골랐고, 무동작 20초는 아직 근거 데이터가 없다). 벗어서 떨어뜨린 헬멧은 "충격 뒤 무동작"으로 경보가 확정된다
- 신체 착용 태그의 BLE 연동, 근접 사고 자가 보고(8.3), 음성·회복 신호(5.4, 6.3.5), 개인화 임계값
- 위치정보사업 신고 등 법적 절차(9.1) — 운영 전 필수
