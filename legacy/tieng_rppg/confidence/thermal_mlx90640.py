"""
TouchFree Vitals — MLX90640 열화상 캡처 + 콧구멍 ROI 추출

역할 분리
---------
이 파일은 "카메라에서 32x24 온도 프레임을 얻고, 그중 콧구멍 ROI의 평균온도/
픽셀수/대비를 뽑는" 하드웨어 접점만 담당한다. 호흡 주파수 추정은 그 값을 받는
respiration.ThermalNostrilSource + RespirationEstimator 가 한다 — 이 파일은
그쪽을 모른다(반대도 마찬가지). rppg_demo_v4.py 가 얼굴 검출로 RGB ROI를 찾듯,
열화상 ROI 좌표(코 위치)를 정하는 것도 이 파일의 책임이 아니다 — 호출 쪽이
RGB 얼굴 박스에서 오프셋으로 계산해 roi_stats() 에 넘긴다.

하드웨어 없이 개발/검증
------------------------
adafruit-circuitpython-mlx90640 또는 I2C 버스가 없으면 open_camera()가 자동으로
SyntheticThermalCamera로 대체된다 (rppg_demo_v4._maybe_facemesh_engine과 같은
폴백 패턴). selftest_thermal.py는 항상 synthetic 경로로 돈다 — 카메라 없이도
전체 신호처리 경로(캡처→ROI→ThermalNostrilSource→RespirationEstimator)를
검증할 수 있다.

MLX90640 특이사항 (설계에 반영됨)
---------------------------------
* FFC(플랫필드 보정) 셔터가 없다 — Lepton과 달리 ffc_active는 이 센서에서는
  항상 False로 둔다 (ThermalContext 필드 자체는 센서 공통이라 그대로 둠).
* 정식 해상도 32x24 = 768 픽셀. 코 하나가 몇 픽셀 안 남을 수 있으므로 ROI가
  ThermalContext.T_MIN_ROI_PIXELS(=4)를 못 채우면 게이트가 즉시 막는다.
  실장비 입고 후 "카메라-얼굴 거리 vs ROI 픽셀수"를 실측해 가이드라인을 잡을 것.
* 권장 refresh rate는 2~8Hz(정확도용 — 라이브러리 기본은 더 높게도 낼 수 있지만
  프레임당 노이즈가 커진다). 호흡 대역(0.1~0.5Hz)엔 나이퀴스트 여유가 충분하다.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

FRAME_W = 32
FRAME_H = 24
FRAME_N = FRAME_W * FRAME_H


@dataclass
class ThermalFrame:
    """32x24 온도 그리드(섭씨) 한 장 + 타임스탬프(초, 임의 원점)."""
    t: float
    grid: np.ndarray   # shape (24, 32), float, 섭씨


def roi_stats(frame: ThermalFrame, roi_box: Tuple[int, int, int, int]) -> Tuple[float, int, float]:
    """ROI 내부의 (평균온도, 픽셀수, 최대-최소 온도차)를 낸다.

    roi_box = (x, y, w, h), 프레임 좌표계(32열 x 24행) 기준. 프레임 경계 밖으로
    나간 부분은 잘라낸다 — 코가 화면 가장자리에 걸쳐도 죽지 않게.
    ThermalContext.roi_pixels / delta_t_contrast 를 채우는 용도로 그대로 쓰면 된다.
    """
    x, y, w, h = roi_box
    x0, y0 = max(int(x), 0), max(int(y), 0)
    x1, y1 = min(int(x + w), FRAME_W), min(int(y + h), FRAME_H)
    if x1 <= x0 or y1 <= y0:
        return float("nan"), 0, 0.0
    patch = frame.grid[y0:y1, x0:x1]
    return float(patch.mean()), int(patch.size), float(patch.max() - patch.min())


class SyntheticThermalCamera:
    """하드웨어 없이 개발/selftest용. 고정 ROI에 호흡 진폭을 심은 합성 프레임을 낸다.

    배경은 실내 벽 정도(24도)로 두고, ROI 자리에만 체온 근처(base_c) ± 호흡
    진폭(amp_c)을 얹는다. 실제 콧구멍 열화상 파형이 정현파가 아니지만, 이 모듈은
    "캡처 계층이 신호를 왜곡 없이 넘기는가"만 검증하면 되므로 단순화했다
    (파형 형태 자체의 정확도는 confidence/selftest_respiration.py가 이미 검증).
    """

    def __init__(self, rpm: float = 15.0, seed: int = 0,
                 base_c: float = 33.0, amp_c: float = 1.2, noise_c: float = 0.15,
                 roi: Tuple[int, int, int, int] = (13, 9, 6, 5)):
        self.rpm = rpm
        self.rng = np.random.default_rng(seed)
        self.base_c = base_c
        self.amp_c = amp_c
        self.noise_c = noise_c
        self.roi = roi
        self._t = 0.0

    def read(self, dt: float = 0.25) -> ThermalFrame:
        self._t += dt
        grid = np.full((FRAME_H, FRAME_W), 24.0, float)
        x, y, w, h = self.roi
        f = self.rpm / 60.0
        breathing = self.amp_c * np.sin(2 * np.pi * f * self._t)
        grid[y:y + h, x:x + w] = self.base_c + breathing
        grid += self.rng.normal(0, self.noise_c, grid.shape)
        return ThermalFrame(t=self._t, grid=grid)


class MLX90640Capture:
    """실 하드웨어 래퍼 (adafruit-circuitpython-mlx90640).

    I2C 버스나 라이브러리가 없으면 생성자에서 예외를 낸다 — 호출 쪽은
    open_camera()를 통해 try/except로 잡고 SyntheticThermalCamera로 대체한다.
    직접 쓸 때도 같은 패턴을 따를 것 (facemesh_engine, rr_engine과 동일).
    """

    def __init__(self, refresh_hz: float = 4.0, i2c_freq: int = 400_000):
        import board
        import busio
        import adafruit_mlx90640

        i2c = busio.I2C(board.SCL, board.SDA, frequency=i2c_freq)
        self._mlx = adafruit_mlx90640.MLX90640(i2c)
        self._mlx.refresh_rate = _nearest_refresh_rate(adafruit_mlx90640, refresh_hz)
        self._buf = [0.0] * FRAME_N

    def read(self, dt: Optional[float] = None) -> ThermalFrame:
        self._mlx.getFrame(self._buf)
        grid = np.array(self._buf, float).reshape(FRAME_H, FRAME_W)
        return ThermalFrame(t=time.time(), grid=grid)


def _nearest_refresh_rate(adafruit_mlx90640, hz: float):
    """요청 Hz에 가장 가까운 라이브러리 상수를 고른다. 라이브러리가 이산값만 지원."""
    table = {0.5: "REFRESH_0_5_HZ", 1: "REFRESH_1_HZ", 2: "REFRESH_2_HZ",
             4: "REFRESH_4_HZ", 8: "REFRESH_8_HZ", 16: "REFRESH_16_HZ",
             32: "REFRESH_32_HZ", 64: "REFRESH_64_HZ"}
    nearest = min(table, key=lambda k: abs(k - hz))
    return getattr(adafruit_mlx90640.RefreshRate, table[nearest])


def open_camera(force_synthetic: bool = False, **synthetic_kwargs):
    """실 하드웨어를 우선 시도하고, 실패하면 synthetic으로 폴백한다.

    반환: (camera, fallback_message). message가 None이 아니면 폴백된 이유
    (rppg_demo_v4.py의 [facemesh]/[rr] 콘솔 메시지와 같은 용도).
    """
    if force_synthetic:
        return SyntheticThermalCamera(**synthetic_kwargs), None
    try:
        return MLX90640Capture(), None
    except Exception as e:
        return SyntheticThermalCamera(**synthetic_kwargs), f"MLX90640 미검출({e}) — synthetic으로 대체"
