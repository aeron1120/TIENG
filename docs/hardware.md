# 하드웨어 연동

센서를 꽂고 값이 뜰 때까지의 순서. **한 번에 다 꽂지 말고 하나씩** 붙이면서
`scripts/hwcheck.py` 로 확인하는 편이 훨씬 빠르다.

지금 코드는 하드웨어가 없어도 전부 돌아간다. 어댑터가 드라이버를 `start()` 안에서
늦게 import 하므로, 없으면 그 카드만 `어댑터 없음` 회색으로 뜨고 나머지는 정상
동작한다. 즉 **꽂는 순서대로 카드가 하나씩 살아난다.**

---

## 0. 파이 준비

이미지는 **64비트**를 쓴다. numpy·scipy·opencv-python 이 aarch64 휠로 바로 깔린다 —
32비트는 공식 휠이 없어 OpenCV 를 몇 시간 걸려 소스 빌드하게 된다.

tfv-pi-01 은 **Pi 5 + Pi OS Trixie(Debian 13, Python 3.13)** 로 올렸고 위 패키지가
전부 cp313 aarch64 휠로 깔렸다. `pyproject.toml` 의 `requires-python = ">=3.11"` 이라
Bookworm(3.11)과 Trixie(3.13) 어느 쪽이든 그대로 돈다.

Imager 의 OS 커스터마이즈(톱니바퀴)에서 **SSH·계정·Wi-Fi·국가코드**를 채운 뒤 굽는다.
빼먹으면 헤드리스로는 붙을 방법이 없다. 요즘 Imager 는 이 설정을 부트 파티션의
**cloud-init 파일**(`user-data`·`network-config`·`meta-data`)로 쓴다 — 예전 문서가
말하는 `custom.toml`·`firstrun.sh`·빈 `ssh` 파일을 찾으면 없다. 잘 구워졌는지는 SD 를
PC 에 꽂아 그 세 파일이 있는지로 확인한다.

```bash
sudo raspi-config          # Interface Options → I2C → Enable
sudo reboot

sudo apt install -y i2c-tools python3-picamera2
git clone <repo> && cd TIENG

# --system-site-packages 를 빼면 안 된다. picamera2 는 apt 로만 깔리는데,
# 평범한 venv 는 시스템 패키지를 가려서 CSI 카메라가 통째로 안 보인다.
python -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -e ".[dev,pi]"          # pi extras 가 나머지 드라이버를 깐다
```

데스크톱 이미지에는 `python3-picamera2` 가 이미 들어 있어 위 apt 는 대개 할 일이
없다. Lite 이미지면 이때 깔린다.

`pi` extras 에 들어 있는 것: `smbus2`, `bme680`, `gpiozero`, `lgpio`, `tinytuya`,
`adafruit-circuitpython-mlx90640`(열화상, blinka 가 `board`/`busio` 를 같이 깐다).
개발 PC 에서는 설치하지 않는다 (설치도 안 되고 import 도 안 된다).

`picamera2` 는 extras 에 없다. libcamera 파이썬 바인딩에 묶여 있어 pip 로는 안 깔리고,
넣어 두면 `pi` extras 설치가 통째로 실패한다. 그래서 위처럼 apt 로 깔고 venv 가
그걸 들여다보게 한다.

**Legacy Camera 는 켜지 말 것.** 오래된 문서들이 카메라를 쓰려면 raspi-config 에서
활성화하라고 하는데, 켜면 libcamera 스택이 죽어 picamera2 가 아예 못 돈다. 요즘
이미지는 카메라를 자동 인식하므로 여기서 켤 것은 I2C 뿐이다.

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
| MLX90640 (열화상) | VIN | 3.3V | 1 (공유) |
| | GND | GND | 20 |
| | SDA | GPIO2 | 3 (공유) |
| | SCL | GPIO3 | 5 (공유) |

- I2C 는 **버스를 공유**한다. BME680(0x76), BH1750(0x23), MLX90640(0x33)을 같은
  SDA/SCL 에 물린다. 3.3V 핀은 헤더에 1·17 둘뿐이라 셋을 다 꽂으려면 브레드보드로
  레일을 나눠 써야 한다.
- **MLX90640 은 I2C 를 400kHz 로 올려야 한다.** 32x24=768 픽셀을 4Hz 로 받기에
  기본 100kHz 로는 모자라서 프레임이 깨진다. 어댑터가 busio 에 400000 을 넘기지만
  파이에서 실제 버스 속도를 정하는 것은 커널 파라미터다:

  ```
  # /boot/firmware/config.txt — 고치고 재부팅
  dtparam=i2c_arm_baudrate=400000
  ```

- PIR 만 5V 다. OUT 신호는 3.3V 라 GPIO 에 바로 넣어도 된다.
- 카메라(rPPG)는 CSI 또는 USB. `camera_index` 는 보통 0. **어느 쪽인지는
  `backend` 로 적어 준다** — CSI 리본이면 `picamera2`, USB 웹캠이면 `opencv`.
  CSI 는 `opencv` 로 안 열린다. `/dev/video0` 으로 잡히긴 하지만 그건 디베이어 전
  raw 프레임이다. 꽂았으면 `rpicam-hello --list-cameras` 에 보이는지부터 확인한다.
  - Pi 5 는 카메라 커넥터가 22핀이므로 **15핀↔22핀 변환 케이블**이 필요하다.
  - USB 웹캠이면 노출·화벨 고정이 드라이버 마음이라 신호가 나빠진다.

### 카메라가 보이는데 프레임이 안 올 때

`rpicam-hello --list-cameras` 에는 멀쩡히 뜨는데 실제 캡처가 이렇게 죽는 경우:

```
Camera frontend has timed out!
Please check that your camera sensor connector is attached securely.
```

**커넥터를 반대쪽 CAM/DISP 로 옮기면 살아난다.** tfv-pi-01 이 그랬다 — 리본을 몇 번
다시 꽂아도 안 되다가 옆 커넥터로 바꾸니 바로 됐다.

증상을 읽는 법이 있다. 목록에 뜬다는 것은 **I2C 제어선은 통했다**는 뜻이고, 프레임이
안 온다는 것은 **CSI 데이터선만 불통**이라는 뜻이다. 둘은 같은 커넥터를 지나므로
"인식되니까 케이블은 괜찮다"는 판단이 틀린다. 리본이 살짝 비뚤어도 제어 핀은 닿고
데이터 레인은 안 닿는다.

순서대로 해 볼 것 — **전원을 뽑고** 만진다 (인가 상태에서 CSI 를 만지면 모듈이 죽는다):

1. 양쪽 끝 리본 재장착. 접점이 커넥터 안으로 완전히 들어가야 한다
2. **다른 CAM/DISP 커넥터로 이동** (Pi 5 는 두 개다)
3. 리본 교체. Pi 5 는 22핀이라 15↔22핀 변환 케이블을 쓰는데 이게 범인인 경우가 많다

`rpicam-hello --timeout 3000 --nopreview` 가 에러 없이 끝나면 해결된 것이다.

### 카메라가 "No cameras available" 일 때

`camera_auto_detect=1` 이 항상 잡아 주지는 않는다. tfv-pi-01(Camera Module 3)이
그랬다. 이때 **오버레이를 명시**하면 뜬다:

```
camera_auto_detect=0
dtoverlay=imx708,cam0      # 모듈에 맞게. v2 는 imx219, HQ 는 imx477, v1 은 ov5647
```

모델을 모르면 추측하지 말고 센서에게 직접 물어본다. 함정은 **Pi 5 가 오버레이를
로드해야 카메라 커넥터의 전원 레귤레이터를 켠다**는 점이다 — 그 전에는 센서가
꺼져 있어서 `i2cdetect` 가 비어 있고, 그걸 보고 "안 꽂혔다"고 오판하기 쉽다.
레귤레이터를 손으로 켜면 모듈 전체가 보인다:

```bash
# cam0_reg 를 켜는 GPIO 번호를 디바이스트리에서 읽는다 (tfv-pi-01 은 34였다)
od -An -tx4 /proc/device-tree/cam0_reg/gpio     # 두 번째 값이 GPIO 번호
sudo pinctrl set 34 op dh                       # 카메라 전원 ON

# 카메라 버스는 i2c-1 이 아니라 i2c-10(CAM0) / i2c-11(CAM1) 이다
sudo i2cdetect -y 10          # 센서 0x1a, AF 모터 0x0c, EEPROM 0x50 이 보인다
sudo i2ctransfer -y 10 w2@0x1a 0x00 0x16 r2     # 칩 ID → 0x07 0x08 이면 IMX708
```

배선 후 주소가 보이는지 먼저 확인한다:

```bash
i2cdetect -y 1
#      0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f
# 20:  -- -- -- 23 -- -- -- -- ...      ← BH1750
# 30:  -- -- -- 33 -- -- -- -- ...      ← MLX90640
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
python scripts/selftest.py      # 신호처리 + 품질 게이팅 + L1 정책, 28개 항목
```

---

## 4. 띄우고 눈으로 확인

파이에서는 화면을 **빌드해서** 내보낸다. vite dev 서버를 띄우지 않는 이유는 포트가
하나면 프록시도 CORS 도 필요 없기 때문이다 — `api/main.py` 가 `web/dist` 가 있으면
알아서 같은 포트로 서빙한다. 노드는 이미지에 없으므로 한 번 깔아야 한다.

```bash
sudo apt install -y nodejs npm      # 처음 한 번만
cd web && npm install && npm run build && cd ..

DEVICE_CONFIG=config/device.yaml uvicorn api.main:app --host 0.0.0.0 --port 8000
```

같은 LAN 의 다른 기기에서 `http://<파이 IP>:8000/` 으로 접속된다. 폰으로 열어도 된다.
`--host 0.0.0.0` 을 빼면 파이 자신에서만 열린다.

화면 코드를 고치는 중이라면 개발 PC 에서 `npm run dev` 를 띄우는 편이 빠르다. 대신
`web/vite.config.ts` 의 프록시 대상이 `127.0.0.1:8000` 이라 파이를 보게 바꿔야 한다.

접속하면 첫 화면이 로그인 관문이다. **회원가입**부터 하면 첫 계정이 관리자가 된다.
비회원 접속은 실시간 화면만 열려서 시스템 상태·기록은 보이지 않는다.

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
