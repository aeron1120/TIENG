# 측정 세션 런북 — MD300C22 폰녹화 + 수동판독

> 목적: export 안 되는 **MD300C22** 옥시미터로도 카메라 rPPG를 정량 검증한다.
> 옥시미터 화면을 폰으로 녹화 → 맥박(PR)을 2초 간격으로 읽어 CSV → 기존 `evaluate.py`로 오차 산출.
> 코드 수정 불필요. `evaluate.py`가 `--offset`/`--tolerance`(기본 2초)/`--sqi-gate`/all·pass·fail 비교/Bland-Altman을 이미 지원함.

---

## 준비물
- 웹캠 PC(rPPG 데모 실행)
- MD300C22 옥시미터 + 폰(옥시미터 화면 녹화용)
- 옥시미터는 **머리 안 움직이는 손가락**에 착용(예: 왼손). 카메라엔 얼굴이 잡히게.

---

## 촬영 원칙 (핵심 4가지)
1. **손가락 옥시미터라 머리 움직임과 무관하게 화면값은 항상 정확히 읽힌다.** → head_motion 시나리오에서도 기준값은 멀쩡. 카메라 SQI만 떨어지는 걸 잡는 게 목적.
2. **옥시미터는 거치대(책더미 등)에 세워 단독 촬영해도 된다.** 손으로 들고 있을 필요 없음(불편함 해소). 노트북 화면이 같이 안 잡혀도 무방 — 아래 3번 방식으로 동기화.
3. **공통 t=0 = 거의 동시 시작.** 손뼉 없이도, 폰 녹화 시작과 데모 실행(Enter) 사이 시간차를 1~2초 이내로만 맞추면 된다. 두 시계열의 오르내리는 패턴을 상관계수로 자동 정렬(`--auto-offset`)하는 방식으로 정밀 동기화한다.
4. **시나리오는 하나씩 따로** 찍는다(각자 t=0가 깔끔하도록). run_experiment.py 연속 실행은 커버리지 요약용으로만.

> **옥시미터 착용 직후 ~20초는 판독값이 불안정(장비 안정화 구간)할 수 있음** — static 3회 반복 검증에서 확인됨(상관계수가 초반 포함 시 거의 0, 20초 이후만 쓰면 0.5~0.8). `evaluate.py --ref-warmup-sec 20`으로 이 구간을 자동 제외할 것.
> **`--auto-offset` 결과가 `--max-lag`(기본 ±5초) 경계값에 걸리면** 진짜 최적점이 아닐 수 있으니 `--max-lag 10`처럼 범위를 넓혀서 상관계수가 더 개선되는지 재확인할 것.
> **rPPG 데모 쪽도 첫 유효 HR 이후 ~20~30초는 알고리즘 시동 구간(하모닉 배가 오류)으로 크게 틀릴 수 있음** — head_motion 1회 검증에서 발견(첫 값이 실제의 약 2배로 나와 서서히 수렴, 이 구간 SQI는 낮지 않음 → 게이팅으로 안 걸러짐). `evaluate.py --demo-warmup-sec 30`으로 이 구간을 배제할 것. 원본(미배제) 결과도 참고용으로 남겨 알고리즘 개선 포인트로 보고할 것.

---

## 시나리오별 촬영 (각 60초)

먼저 이전 python 프로세스가 안 남아있는지 확인(카메라 중복 점유 시 화면 깨짐 — HANDOFF 경고).

```powershell
cd C:\TIENG\tieng_rppg
# 남은 python 프로세스 정리(필요 시)
Get-Process python -ErrorAction SilentlyContinue | Stop-Process
```

### 1) static — 정지·정면, 조명 고정
```powershell
python rppg_demo_v4.py --scenario static --duration 60 --log validation\static_demo.csv
```
절차: 폰 녹화 시작 → 위 명령 실행 → **콘솔에 카메라 창 뜨는 순간 손뼉 1번** → 60초 정지 응시 → 자동 종료.

### 2) lighting — 정지, 중간에 조명 변화
```powershell
python rppg_demo_v4.py --scenario lighting --duration 60 --log validation\lighting_demo.csv
```
절차: 동일. 30초쯤 스탠드 on/off 또는 창측으로 밝기 변화. 손 대신 조명만.

### 3) head_motion — 천천히 좌우 회전·끄덕임
```powershell
python rppg_demo_v4.py --scenario head_motion --duration 60 --log validation\head_motion_demo.csv
```
절차: 동일. 60초간 고개를 천천히 좌우/끄덕. **옥시미터 낀 손은 고정.**

> 반복·다피험자: 파일명에 접미사(`static_demo_p1_r1.csv` 등)만 붙여 반복. N은 정직하게 기록.

---

## 기준값 CSV 만들기 (수동판독)

각 시나리오 폰 영상에서, **손뼉 프레임을 elapsed 0초**로 잡고 옥시미터 PR을 읽어 아래 형식으로 저장.

`validation\static_ref.csv` (템플릿: `ref_template.csv` 복사해서 값만 교체):
```
elapsed_sec,pr
0,72
2,72
4,73
...
60,71
```
- **static/lighting는 2초 간격** — evaluate.py 기본 `--tolerance 2.0`과 맞음. 맥박은 천천히 변해서 2초면 충분.
- **head_motion은 1초 간격**(권장). VALIDATION_PROTOCOL §3-1은 원래 수기판독이 head_motion엔 "연속성 낮아 부적합"하다고 봤음 — 손가락 PR 값 자체는 머리 움직임과 무관해 안정적이지만, 판독 촘촘함을 2배로 올려 정렬·매칭 여유를 확보해 이 우려를 완화한다. `head_motion_ref.csv`를 만들 땐 `evaluate.py` 실행 시 `--tolerance 1.0`도 함께 지정할 것(§ "오차 산출" 참고).
- PR만 필요(SpO2는 안 씀). 읽기 애매한 프레임은 앞뒤 값으로 보간해도 됨.
- 파일 3개: `static_ref.csv`, `lighting_ref.csv`, `head_motion_ref.csv`.

---

## 오차 산출 (evaluate.py)

시나리오별로 실행. `--out` 폴더에 표 + summary.csv + PNG(scatter/bland_altman/timeline) 생성.

```powershell
python evaluate.py --demo validation\static_demo.csv      --ref validation\static_ref.csv      --sqi-gate 0.5 --auto-offset --ref-warmup-sec 20 --out validation\report\static
python evaluate.py --demo validation\lighting_demo.csv    --ref validation\lighting_ref.csv    --sqi-gate 0.5 --auto-offset --ref-warmup-sec 20 --out validation\report\lighting
python evaluate.py --demo validation\head_motion_demo.csv --ref validation\head_motion_ref.csv --sqi-gate 0.5 --auto-offset --ref-warmup-sec 20 --demo-warmup-sec 30 --tolerance 1.0 --out validation\report\head_motion
```

각 실행은 **all / SQI>=0.5(pass) / SQI<0.5(fail)** 세 줄 표를 출력 → 이게 게이팅 효과(H2) 증거.

### 싱크 미세보정
`--auto-offset`을 켜면 손뼉 정렬 후 남는 잔차 오프셋을 evaluate.py가 **1Hz 상호상관(lag-search, ±5초)으로 자동 탐색**한다(콘솔에 `tau=...`로 출력됨). 상관계수는 두 신호의 평균 차이(bias)에 영향받지 않으므로, "MAE가 최소가 되는 offset을 손으로 찾는" 방식과 달리 **정확도 지표 자체를 오염시키지 않는다** — 항상 이 플래그를 켜서 쓸 것.

손뼉 판독이 크게(3초 이상) 어긋나 자동 탐색 범위(±5초)를 벗어난 경우에만 `--offset`으로 대략 맞춘 뒤 `--auto-offset`으로 미세보정:
```powershell
python evaluate.py --demo validation\static_demo.csv --ref validation\static_ref.csv --offset -6.0 --auto-offset --out validation\report\static
```

---

## 결과 해석 (발표 스토리와 연결)

| 시나리오 | 기대 | 발표 메시지 |
|----------|------|-------------|
| static (pass) | MAE ~5bpm, ±5bpm ~80% | "정적 조건에선 카메라만으로도 신뢰 가능" (H1) |
| head_motion | **all MAE 큼 → pass MAE 급감**, 단 coverage↓ | "믿을 만할 때만 보여준다 = 게이팅 효과" (H2), "대가는 커버리지, 숨기지 않음" (H3) |

> 반드시 **coverage(SQI pass 비율)를 MAE와 함께** 인용. 게이팅 후 MAE만 자랑 금지 — 제품 철학("모를 땐 보류")과 검증의 정합성이 핵심.
> 카메라 단독 수치임을 명시. 논문의 ±3bpm(레이더 융합값)을 우리 성능처럼 쓰지 말 것.

---

## 자주 나는 실수 / 디버깅 포인트
- **carera 창 안 뜨고 검음**: 이전 python 프로세스 잔존 → 위 Stop-Process 후 재실행.
- **evaluate에서 매칭 0개(n=0)**: ref `elapsed_sec` 간격이 tolerance(2s)보다 큼 → 간격을 2초로 줄이거나 `--tolerance 3.0`.
- **ref 열 인식 실패**: 헤더가 `elapsed_sec,pr`인지 확인. 다르면 `--ref-time-col`/`--ref-bpm-col`로 지정.
- **두 곡선이 통째로 밀림**: 손뼉 싱크 오차 → `--auto-offset`으로 자동 정렬(±5초 범위 밖이면 `--offset`으로 대략 맞춘 뒤 `--auto-offset` 병용).
- **head_motion인데 기준 PR이 튐**: 옥시미터 낀 손이 움직였을 가능성 → 손 고정 재촬영.
```
