# 하드웨어 연동

센서를 꽂고 값이 뜰 때까지의 순서. **한 번에 다 꽂지 말고 하나씩** 붙이면서
`scripts/hwcheck.py` 로 확인하는 편이 훨씬 빠르다.

지금 코드는 하드웨어가 없어도 전부 돌아간다. 어댑터가 드라이버를 `start()` 안에서
늦게 import 하므로, 없으면 그 카드만 `어댑터 없음` 회색으로 뜨고 나머지는 정상
동작한다. 즉 **꽂는 순서대로 카드가 하나씩 살아난다.**

---

## 0. 파이 준비

```bash
sudo raspi-config          # Interface Options → I2C → Enable
sudo reboot

sudo apt install -y i2c-tools
git clone <repo> && cd TIENG
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,pi]"          # pi extras 가 드라이버를 깐다
```

`pi` extras 에 들어 있는 것: `smbus2`, `bme680`, `gpiozero`, `lgpio`, `tinytuya`.
개발 PC 에서는 설치하지 않는다 (설치도 안 되고 import 도 안 된다).

---

## 1. 배선

전부 **BCM 번호** 기준이다. 물리 핀 번호와 헷갈리지 말 것.

| 센서 | 핀 | 파이 | 물리 핀 |
|---|---|---|---|
| BME680 (온습도) | VCC | 3.3V | 1 |
| | GND | GND | 6 |
| | SDA | GPIO2 | 3 |
| | SCL | GPIO3 | 5 |
| BH1750 (조도) | VCC | 3.3V | 17 |
| | GND | GND | 9 |
| | SDA | GPIO2 | 3 (공유) |
| | SCL | GPIO3 | 5 (공유) |
| | ADDR | GND | → 주소 0x23 |
| PIR HC-SR501 | VCC | **5V** | 2 |
| | GND | GND | 14 |
| | OUT | GPIO4 | 7 |

- I2C 는 **버스를 공유**한다. BME680(0x76)과 BH1750(0x23)을 같은 SDA/SCL 에 물린다.
- PIR 만 5V 다. OUT 신호는 3.3V 라 GPIO 에 바로 넣어도 된다.
- 카메라(rPPG)는 CSI 또는 USB. `camera_index` 는 보통 0.

배선 후 주소가 보이는지 먼저 확인한다:

```bash
i2cdetect -y 1
#      0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f
# 20:  -- -- -- 23 -- -- -- -- ...      ← BH1750
# 70:  -- -- -- -- -- -- 76 --          ← BME680
```

주소가 다르면 `config/device.yaml` 의 `i2c_addr` 을 고친다 (BME680 은 0x77,
BH1750 은 ADDR 을 VCC 에 물리면 0x5c).

---

## 2. Tuya 플러그/전구

클라우드가 아니라 **LAN 으로 직접** 제어한다. 인터넷이 끊겨도 개입이 동작해야 하고,
집 안 값이 밖으로 나가지 않아야 한다.

```bash
python -m tinytuya wizard
```

Smart Life 앱에 기기를 먼저 등록해 두어야 하고, wizard 가 뽑아 주는
`device_id` / `local_key` / `ip` 를 `config/device.yaml` 의 `room_light` params 에
적는다. `version` 은 보통 3.3, 안 되면 3.4.

---

## 3. 하나씩 확인

```bash
python scripts/hwcheck.py
```

어댑터를 실제로 `start()` → `read()` 해 보고 실패하면 다음에 확인할 것을 알려 준다.
전구는 2초간 실제로 켰다 끈다 (건드리기 싫으면 `--skip-actuators`).

```
[센서]
  OK  bme680         (live)  temp=24.1°C, humidity=41.0%
  XX  bh1750         (live)  start 실패: [Errno 121] Remote I/O error
        - i2cdetect -y 1 에 0x23 (또는 0x5c) 이 보이는지
        - ADDR 핀이 GND 면 0x23, VCC 면 0x5c
```

알고리즘 쪽은 하드웨어 없이 따로 본다:

```bash
python scripts/selftest.py      # 신호처리 + 품질 게이팅 + L1 정책, 23개 항목
```

---

## 4. 띄우고 눈으로 확인

```bash
DEVICE_CONFIG=config/device.yaml uvicorn api.main:app --host 0.0.0.0 --port 8000
cd web && npm run dev
```

같은 LAN 의 다른 기기에서 `http://<파이 IP>:5173/` 으로 접속된다.

확인할 것:

1. 꽂은 센서의 카드가 **금색 `실측`** 뱃지로 바뀐다 (회색 `미연결` 아님)
2. 카메라 앞에 앉으면 심박수가 뜬다 (12초 창이 차야 하므로 처음엔 보류)
3. **불을 끄면** 조도가 떨어지고 → 신뢰도가 내려가고 → L1 이 발화해 전구가 켜지고
   → 20초 뒤 `개입 기록` 카드에 전후 비교가 찍힌다

3번이 Phase 3 완료 기준이다.

---

## 5. 개입이 안 터질 때

`logs/interventions.csv` 를 먼저 본다. `kind=blocked` 행에 **왜 안 했는지**가 있다.

| 사유 | 뜻 | 조치 |
|---|---|---|
| `야간 모드 —` | 22~07시 | 의도된 동작. 테스트하려면 `thresholds.yaml` 의 `night_mode` 를 잠시 바꾼다 |
| `조명 액추에이터가 연결돼 있지 않다` | Tuya 로드 실패 | `hwcheck` 로 확인, `local_key` 재발급 |
| `조도 ...lx 는 충분하다` | 방이 안 어둡다 | `lux_min` 을 올리거나 실제로 더 어둡게 |
| `신뢰도 ... 는 기준 이상` | 신호가 멀쩡하다 | 정상. 얼굴을 가리거나 조명을 낮춘다 |
| `쿨다운 ...초 대기 중` | 최근에 이미 켰다 | `cooldown_s` 를 줄이거나 기다린다 |

blocked 행은 **주 조건이 맞았는데 막힌 경우만** 남는다. 조건 자체가 안 맞은 순간까지
전부 적으면 파일이 그걸로 덮여 정작 필요한 기록이 묻힌다.

---

## 6. 부팅 시 자동 실행 (Phase 4)

```bash
sudo cp deploy/tfv.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tfv
journalctl -u tfv -f
```

`User`, `WorkingDirectory`, `.venv` 경로가 다르면 유닛 파일을 먼저 고친다.

사용자가 `video` / `i2c` / `gpio` 그룹에 없으면 어댑터가 `start` 에서 죽는다:

```bash
sudo usermod -aG video,i2c,gpio pi && sudo reboot
```

종료 신호는 SIGINT 로 보내고 20초를 준다. 그 사이에 켜 둔 불을 끄고 나간다 —
서버를 껐는데 불이 켜진 채로 남으면 안 된다.

---

## 7. 정량 검증 (Phase 5)

옥시미터를 끼고 잰 기준 CSV 가 있으면:

```bash
python scripts/validate_vs_oximeter.py \
    --rppg logs/metrics.csv --ref logs/oximeter.csv \
    --gate 0.4 --ref-warmup-sec 20 --out reports/accuracy.md
```

`--ref-warmup-sec` 를 빼먹지 말 것. 옥시미터는 손가락에 끼운 뒤 값이 안정되기까지
20초쯤 걸리고, 그 구간을 기준으로 쓰면 카메라가 틀린 것처럼 보인다.

시작시각 보정은 상호상관으로 자동 탐색한다(`--offset` 으로 수동 지정 가능).
MAE 를 최소화하는 방식이 아니라 상관을 최대화하므로 보고할 지표를 깎지 않는다.

리포트에 실행 명령이 함께 박힌다. 예전 아카이브 리포트는 인자를 안 남겨 재현이
안 됐는데, 같은 실수를 반복하지 않기 위해서다.

---

## 8. 아직 안 붙인 것

| 항목 | 계획 |
|---|---|
| 기압·VOC | BME680 이 주지만 2절 계약의 metric key 목록에 없다. 추가하려면 계약부터 |
| mmWave LD2410 | 재실 정밀도 개선. PIR 로 먼저 검증 후 |
| 마이크 소음(I2S) | Phase 5 |
| systemd 자동 실행 | Phase 4 |
