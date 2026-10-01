# Rider Guard 웹앱 요청 — 구현 결과 (2026-09-30)

요청: `2026-09-30-webapp-request.md`. 인증 세부는 `auth-task-report.md`.
이 문서는 구현 상태 기록이며, 실제 센서·연락처 전송·Google 운영 로그인을 검증했다는 확인서가 아니다.

## 구조 확인 결과

- 인증: 자체 서버(Hono + libSQL) + 불투명 Rider Guard 토큰. Supabase/Firebase 아님. Google은 서버 authorization-code 흐름(전체 페이지 이동, 팝업 없음).
- 판정 위치: 서버. 장치(`/device-api/indicators`) 또는 휴대폰(`/me/indicators`)이 센서 시각 표본을 보내면 `services/sensor-analysis.ts`가 판정한다. 웹앱은 IMU를 직접 받지 않는다.
- 전송: SMS·119·배달대행은 콘솔(모의) 어댑터 — 운영에서도 `simulated`로 기록되고 실제로 아무에게도 보내지 않는다.

## 규칙과 시간값

| 값 | 출처 | 비고 |
|---|---|---|
| 6 g · 300 °/s · ΔV 3 m/s · \|뱅크\| 45° · 창 0.5 s · ΔV 0.15 s · 시작 0.15 s | `SENSOR_RULE` (`imu-report-v1`) | 보고서 초기 규칙. 최적값 아님 |
| 본인 응답 대기 30 s | `COUNTDOWN_SECONDS` | 운영값, 센서 창과 무관 |
| 다음 연락처 간격 60 s | `CONTACT_STAGGER_SECONDS` | 앱 화면도 60 s로 맞춤(이전 180 s 표시는 서버와 불일치였음) |
| 센서 오래됨 60 s | `SENSOR_STALE_SECONDS` | 기존 heartbeat 온라인 기준 |

과거 기록: `evidenceJson`에 `analysis`가 없는 기록은 "규칙 버전이 기록되기 전의 근거"로 표시하고 값을 지어내지 않는다. 기존 `/v1/detections` v1 규칙 경로는 그대로 유지.

## 이번에 마저 구현한 것

- 사고 확인(`alert.tsx`): "사고가 의심돼요. 괜찮으신가요?", '도움이 필요해요', 음성 응답 미지원 표시(가짜 음성 안내 제거), '괜찮아요'를 오탐으로 부르지 않음.
- 기록 상세(`status.tsx` + `components/IncidentEvidence.tsx`): 판정·품질 한 줄("사고 후보 감지 / ΔV 계산 불가 · 일부 누락"), 데이터 출처 배지, 규칙 버전·창, 지표별 기준·통과값·통과 시각·피크·피크 시각, 누락·시간 이상·ΔV 유효 비율(구간·분모)·무효 사유·축별 레일 접근, 장치 메타데이터(없으면 '기록 없음'), 4개 파형(임계 점선·판정창 음영·후보선·결측에서 끊김·포화 표시, 픽셀별 최소/최대 축약으로 피크 보존). 모의 전송이면 "실제 전송 없음"으로 표시.
- 기록 파일: 서버 `/me/incidents/:id/export`(동의 필요)를 웹 JSON 다운로드/네이티브 공유로 연결. '보험·산재 접수에 쓸 수 있어요' 문구와 동의 없는 텍스트 공유 제거.
- 설정: 음성 응답 '미지원', 동의 문구를 실제 기능(기록 파일 제공)에 맞춤, 미리보기에 '모의 화면 · 실제 전송 없음'.
- 긴급 알림/잠금화면 미리보기: 모의 표시, 도움 요청/무응답 문구 구분, '119에 신고했어요'가 앱의 신고처럼 보이지 않게.
- 무한 로딩: 운영 API 콜드 스타트가 약 28초로 측정됨. 세션 복원 8초 제한이 이를 '서버 연결 불가'로 만들던 것을 45초로 늘리고 6초 후 이유를 안내.
- 데모: `apps/server/src/services/mock-cases.ts` D6/B3/C3 mock fixture(1 kHz 합성, `dataSource: mock`, 실측 재생 아님), `scripts/demo-cases.ts`.
- 판정 수정: ΔV 무효 사유를 비율과 같은 구간(판정 시작 이후)에서만 모은다.

## 검증

- 서버 `npm test` 107/107, `typecheck`, `lint` 통과.
- 앱 `tsc --noEmit`, `eslint src test`, `npm test`(파형 헬퍼 4개), `npm run build:web` 통과. 번들에 비밀값 문자열 없음.
- 실행하지 못함: 브라우저 화면 확인, Google 실제 로그인(운영 `/auth/providers`가 `social: []` — 키 미설정), 실제 장치 실측, 운영 배포.

## 재현

```sh
cd rider-guard/apps/server && node scripts/demo-cases.ts            # 판정 요약
# 로컬 서버 + 웹앱 로그인 + 운행 시작 후:
RIDER_TOKEN=<토큰> node scripts/demo-cases.ts --post C3            # 기록 상세 화면에서 확인
```

## ESP32 MOCK 기록 재생 (추가, 2026-10-01 출처 정정)

- `legacy/moto_sensing/ESP32_MPU6050/data/REAL_*_repeat1.npz` 29조건 1회차를 `apps/server/fixtures/esp32-mock/*.json.gz`(사건 중심 −1.0~+0.5초)로 옮겼다. 다시 만들기: `scripts/export-esp32.py`(numpy 필요). 같은 조건 5회 요약(평균·표본 SD)과 기존 시뮬레이션 요약(SIM_reference)도 함께 담는다.
- **출처: MOCK.** 파일 접두사는 `REAL_`이지만 원본 보고서 `ESP32_MPU6050_헬멧_IMU_MOCK_실험보고서`와 재현 코드가 합성 자료이고 실제 실험 0회로 명시돼 있다. 2026-09-30에 `measured`로 붙였던 표시를 `mock`으로 바로잡았다. 참조 채널(dv_true·roll_true·latent_*)은 옮기지 않았다.
- 결과: 운영 규칙 `imu-report-v1`이 29/29 조건에서 기록의 후보 여부와 첫 후보 시각(같은 표본)을 재현한다. 1회차 29건 대조일 뿐이며 검출률·오경보율로 일반화하지 않는다.
- 발표자료 초안 기준(4g·600°/s·75°)은 `PPT_DRAFT_RULE`로 따로 돌려 비교만 한다(사고를 열지 않음). 29조건 분류는 같고, 후보를 1~29ms 먼저 건다.
- 발견: 정상 주행 10건 중 8건은 판정창에 1~3개 순번 누락이 있어 `no_candidate`가 아니라 `insufficient`(판정 정보 부족)로 나온다. 바꾸려면 새 규칙 버전으로 검증할 일이라 그대로 두었다.
- pcx125 시뮬레이션 원본 시계열(pcx125_sim.zip)은 이 저장소에 없다. 발표자료의 다른 집계(311·337회)는 원본·규칙 버전을 확인하지 못해 화면에 싣지 않았다.

## 통합 시연 (/demo, 로그인 없음)

| 주소 | 내용 |
|---|---|
| `/demo` | 라이더 화면 · 배달대행사 관제 화면 · 헬멧 센서 파형을 나란히. 시나리오 A1(전체 흐름)·D6·B3·C3, 재생/일시정지/처음부터, 사건 구간 느리게, 헬멧 센서 끊기, 응답 대기 건너뛰기 |
| `/demo/control` | 관제 화면만 (넓은 화면용) |
| `/demo/rider` | 라이더 화면만 (휴대폰·다른 창용) |
| `/demo/results` | 29조건 결과 비교 — 5회 편차, 두 규칙 판정, 누락·ΔV 유효율, 원본 파형 |
| `/demo/report` | 사건 보고서 — 인쇄·PDF 저장, JSON 내려받기 |

- 파형과 판정: 서버 `GET /demo-api/cases/:id`·`/demo-api/results`(공개, 읽기 전용)가 운영과 같은 `analyzeImu`로 낸 결과. 라이더·주문·관제·위치·연락은 앱 안의 시연 데이터이고 실제로 아무것도 보내지 않는다(`features/demo/engine.ts`, 테스트 `test/demo-engine.test.ts`).
- 같은 브라우저의 창끼리는 BroadcastChannel로 같은 사건·같은 시계를 공유한다. '재생'을 누른 창이 시계를 돌린다. 다른 기기끼리는 묶이지 않는다.
- 응답 대기 30초는 운영 설정값(서버 `COUNTDOWN_SECONDS`)이고 센서 판정 시각과 따로 표시한다. 시연의 '센서 연결 확인 필요' 전환은 5초(운영 60초).
