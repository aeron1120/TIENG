# Rider Guard

심야 배달 라이더 사고 감지·대응 서비스. 설계 근거는 `심야배달라이더_안전시스템_설계문서` (2026-09-10).

```
design/              화면 디자인 원본 (.dc.html, 390×844)
apps/rider/          라이더 앱 — Expo (React Native, TypeScript, expo-router)
apps/server/         API 서버 — Node 24 + Hono + 내장 SQLite(node:sqlite), 빌드 단계 없음
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
- 개발 서버에서는 문자 대신 서버 콘솔에 `[SMS → 번호] 내용` 이 찍히고, 인증번호는 앱에 자동으로 채워진다.

## 데모 순서

1. 앱에서 휴대폰 번호로 가입 → 설정 화면
2. 다른 터미널에서 `cd apps/server && npm run fake-detector` → 표시된 페어링 코드를 앱에 입력 (하드웨어 없이 감지 기기 흉내)
3. 비상연락처 추가 → 설정 완료 → 홈에서 **운행 시작**
4. detector 터미널에서 엔터(충격) 또는 `f`(전도) → 앱에 사고 확인 화면이 뜬다. 홈의 '개발용 · 사고 감지 테스트' 버튼도 같다.
5. **도움이 필요해요** 또는 30초 무응답 → 서버 콘솔에 비상연락 문자, 관제 콘솔(`/ops`)에 사고 접수
6. 관제 콘솔에서 배정받기 → 119 신고 → 대체배차 완료 → 종료. 앱의 상태 화면이 3초 안에 따라 바뀐다.
7. 진행 중 주문 보류·대체배차 흐름을 보려면 사고 전에 `POST /me/dev/order` 로 주문을 만든다 (개발 서버 전용).

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
| `/` | `Main.dc.html` 로그인과 동의 | 동의하고 시작하기 → `/setup` (이미 로그인돼 있으면 `/home`) |
| `/setup` | `Setup.dc.html` 기기 연결과 비상연락망 | 뒤로 → 이전 화면, 연락처 추가/편집 → `/contact`, 설정 완료 → `/home` |
| `/contact` | (디자인 없음) 비상연락처 추가·편집 | 저장·삭제 → `/setup` |
| `/home` | `Home.dc.html` 홈 운행 중 (+ 운행 전 상태) | 수정 → `/setup`, 하단 탭 |
| `/records` | `Records.dc.html` 사고 기록 | 기록 → `/status` |
| `/alert` | `Alert.dc.html` 사고 확인 | 사고 감지 시 어느 화면에서든 자동으로 뜸. 도움이 필요해요 → `/status`, 괜찮아요 → `/home` |
| `/status` | `Status.dc.html` 사고 대응 진행 상황 | 119 / 관제센터 전화, 닫기 → `/home` |

하단 탭: 홈 · 기록 · 연락망(`/setup`) · 설정(디자인 없음, 비활성).

## 코드 구조

`apps/rider/src`
- `theme/` — 색상·폰트·radius 공통 토큰. 화면 코드에 hex 값을 직접 쓰지 않는다.
- `components/` — `ui.tsx`(Screen, Button, Card, Badge, Txt), `Icons.tsx`, `BottomNav.tsx`
- `api/` — `client.ts`(주소·토큰·오류), `hooks.ts`(React Query 조회/변경)
- `auth/AuthProvider.tsx` — 토큰 보관(네이티브 SecureStore, 웹 localStorage), 401 이면 로그인으로
- `features/` — 운행 중 위치 수집, 사고 감지 시 확인 화면 띄우기(`SessionServices`)
- `lib/format.ts` — 서버 상태 → 화면 문구

`apps/server/src`
- `services/incidents.ts` — 사고 상태 기계와 에스컬레이션, `services/scheduler.ts` — 카운트다운 만료·문자 발송·세션 만료 (1초 주기, 재시작해도 DB 에서 이어서 처리)
- `services/sharing.ts` — 공유 링크 권한 판단과 위치 이용내역
- `providers.ts` — SMS · 119 · 배달대행사 연동 지점 (지금은 콘솔 출력)
- `routes/` — 라이더(`/auth`, `/me`), 기기(`/device-api`), 관제(`/ops`), 공유 페이지(`/s/:token`)

## 검사

```bash
cd apps/server && npm test && npm run typecheck    # 에스컬레이션·권한·기기 시나리오 24개
cd apps/rider && npm run typecheck && npm run lint
```

## 아직 없는 것

- 실제 SMS 사업자·119 문자신고·배달대행사 API 연동 (인터페이스만 있음), 주소 변환(역지오코딩)
- 앱이 꺼져 있을 때의 푸시 알림, 백그라운드 위치 수집 — 개발 빌드 필요. 이때도 에스컬레이션 자체는 서버가 진행한다
- 경보음(진동만 구현), QR 스캔(코드 입력으로 대체), 사고기록 PDF·공유, 이름·설정 화면(디자인 없음)
- 신체 착용 태그의 BLE 연동, 근접 사고 자가 보고(8.3), 음성·회복 신호(5.4, 6.3.5), 개인화 임계값
- 위치정보사업 신고 등 법적 절차(9.1) — 운영 전 필수
