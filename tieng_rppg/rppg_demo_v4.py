"""
TouchFree Vitals (TIENG) rPPG webcam demo v4  (+ 논문/기획서 반영 확장판)
========================================================================
카메라 영상만으로 심박수(BPM)를 추정하고, 신호 품질지수(SQI)로 측정 가능 상태를
판단하여 조명/움직임/ROI 품질이 낮은 구간에서는 값 출력을 "보류"하는 예선/시연용 데모.

[v4 코어] (논문 2.2.1 SQI 구조와 정합)
- ROI 후보 3개(forehead/left_cheek/right_cheek) + YCrCb 스킨 마스크 + 피부픽셀 가중 결합
- Welch PSD + parabolic 보간, SQI=f(peak SNR, HR대역 에너지비, ROI/밝기/움직임 페널티)
- SQI 게이트, jump guard, EMA, 확장 CSV, RR 보조지표(가슴 미노출 hold)

[이번 확장] (rppg1 논문 + 기획서 발전 포인트 반영)
- [3순위] 카메라 단독 '레이더 유도 저주파 제거' 대체:
    상체 optical-flow 호흡 신호를 저주파 참조로 회귀 제거(--lowfreq-ref). 논문 4.1.2 아이디어의
    카메라 단독 근사(레이더 대신 흉부 모션을 reference 로 사용).
- [2순위] MediaPipe 볼 다각형 ROI 옵션(--use-facemesh, roi_facemesh.py). 미설치 시 자동 폴백.
- [4순위] SQI 구성요소/시나리오/FPS 로깅(--scenario). 논문 5.2 조건별 표·게이팅 대비 분석용.
- [5순위] 성능 프로파일링(--profile): 프레임 지연/FPS, 종료 시 요약.

유지된 v3 기능: 웹캠 표시 / POS rPPG / 상체 호흡 데모 / CSV / 보호자 알림 데모 / selftest / 면책문구

의존성
    pip install opencv-python numpy scipy          # 기본
    pip install mediapipe                          # --use-facemesh 옵션에만 필요

실행
    python rppg_demo_v4.py
    python rppg_demo_v4.py --selftest
    python rppg_demo_v4.py --log measurements.csv --scenario static --profile
    python rppg_demo_v4.py --lowfreq-ref --use-facemesh --log run.csv --scenario lighting

주의
    연구/교육/시연용입니다. 의료 진단·응급 판단·치료 결정 용도로 사용하지 마세요.
    SpO2(산소포화도)와 혈압은 구현되어 있지 않으며 주장하지 않습니다.
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import platform
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Deque, Iterable, List, Optional, Tuple

import numpy as np
from scipy.signal import butter, detrend, filtfilt, welch
from PIL import Image, ImageDraw, ImageFont


# --------------------------------------------------------------------------- #
# UI (사이드 패널) 색상/폰트 - dataviz 상태 팔레트 기반, 한글은 Pillow로 렌더링
# --------------------------------------------------------------------------- #
UI_SCALE = 3  # 패널을 3배 해상도로 그린 뒤 창 크기에 맞춰 리사이즈(선명도 유지)
UI_PANEL_W = 260
UI_WIN_NAME = "TouchFree Vitals rPPG demo v4"

UI_SURFACE = (26, 26, 25)
UI_HAIRLINE = (44, 44, 42)
UI_INK = (255, 255, 255)
UI_INK_SEC = (195, 194, 183)
UI_INK_MUTED = (137, 135, 129)
UI_GOOD = (12, 163, 12)
UI_WARNING = (250, 178, 25)
UI_CRITICAL = (208, 59, 59)
UI_ACCENT = (57, 135, 229)
UI_TRACK = (44, 44, 42)


def _bgr(rgb: Tuple[int, int, int]) -> Tuple[int, int, int]:
    return (rgb[2], rgb[1], rgb[0])


UI_SURFACE_BGR = _bgr(UI_SURFACE)
UI_ACCENT_BGR = _bgr(UI_ACCENT)
UI_WARNING_BGR = _bgr(UI_WARNING)


def _load_font(bold: bool, size: int):
    name = "malgunbd.ttf" if bold else "malgun.ttf"
    try:
        return ImageFont.truetype("C:/Windows/Fonts/" + name, size)
    except Exception:
        return ImageFont.load_default()


_UI_F_LABEL = _load_font(False, 13 * UI_SCALE)
_UI_F_HERO = _load_font(True, 42 * UI_SCALE)
_UI_F_UNIT = _load_font(False, 15 * UI_SCALE)
_UI_F_BADGE = _load_font(False, 13 * UI_SCALE)
_UI_F_RR = _load_font(True, 25 * UI_SCALE)
_UI_F_INFO = _load_font(False, 13 * UI_SCALE)
_UI_F_FOOT = _load_font(False, 11 * UI_SCALE)
_UI_F_TAG = _load_font(False, 12)

# 히어로 숫자 줄 높이: "--"(placeholder)는 실제 숫자보다 글자 박스가 훨씬 작아서
# textbbox 높이로 다음 줄을 배치하면 값에 따라 배지가 겹친다. 폰트 고정 지표를 써서 항상 동일한 줄 높이를 쓴다.
_UI_HERO_LINE_H = sum(_UI_F_HERO.getmetrics())
_UI_RR_LINE_H = sum(_UI_F_RR.getmetrics())


# --------------------------------------------------------------------------- #
# 데이터 구조
# --------------------------------------------------------------------------- #
@dataclass
class Estimate:
    """HR 추정 결과 + SQI 세부 성분. hold 시에도 사유를 담아 UI/CSV에서 사용."""

    bpm: Optional[float]
    sqi: float
    waveform: np.ndarray
    status: str
    duration: float
    hold_reason: str = ""
    peak_snr_db: float = 0.0
    hr_band_energy_ratio: float = 0.0
    q_snr: float = 0.0
    q_energy: float = 0.0
    q_roi: float = 0.0
    q_brightness: float = 0.0
    q_motion: float = 1.0
    lowfreq_applied: bool = False


@dataclass
class RespirationEstimate:
    rpm: Optional[float]
    sqi: float
    waveform: np.ndarray
    status: str
    duration: float
    hold_reason: str = ""


@dataclass
class RoiSample:
    """선택된 HR ROI의 프레임 단위 메타데이터 (로깅/지터/SQI 입력용)."""

    rgb: Optional[Tuple[float, float, float]]
    skin_pixel_count: int
    skin_ratio: float
    brightness: float
    roi_name: str
    center: Optional[Tuple[float, float]]
    boxes: List[Tuple[str, Tuple[int, int, int, int], bool]] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# 기본 파라미터
# --------------------------------------------------------------------------- #
DEFAULT_WINDOW_SEC = 12.0
DEFAULT_RESP_WINDOW_SEC = 30.0
DEFAULT_MIN_SEC = 8.0
DEFAULT_RESP_MIN_SEC = 18.0
DEFAULT_UPDATE_SEC = 0.5
DEFAULT_FS_RESAMPLE = 30.0
DEFAULT_RESP_FS_RESAMPLE = 10.0
DEFAULT_BPM_MIN = 42.0
DEFAULT_BPM_MAX = 180.0
DEFAULT_RPM_MIN = 6.0
DEFAULT_RPM_MAX = 30.0

DEFAULT_HEART_SQI_GATE = 0.50
DEFAULT_RESP_SQI_GATE = 0.35
DEFAULT_SMOOTH_ALPHA = 0.25
DEFAULT_ALERT_COOLDOWN_SEC = 20.0
DEFAULT_SQI_HYSTERESIS = 0.04  # 신뢰가능/사용가능/보류 배지 전환 dead-band 폭

DEFAULT_MIN_SKIN_PIXELS = 150
DEFAULT_JITTER_SCALE_PX = 6.0
DEFAULT_BETA_MOTION = 0.7          # motion_penalty = 1 - beta * jitter_norm
DEFAULT_SKIN_RATIO_REF = 0.35       # q_roi = clip(skin_ratio / ref, 0, 1)

FULL_BAND_HZ = (0.3, 4.0)           # 에너지비 분모(전체 생리 대역)
RESP_REF_BAND_HZ = (0.1, 0.6)       # 저주파 참조(호흡) 대역


# --------------------------------------------------------------------------- #
# 신호 처리 코어
# --------------------------------------------------------------------------- #
def pos_algorithm(rgb: np.ndarray) -> np.ndarray:
    """POS 알고리즘으로 RGB 시계열에서 맥파 후보 신호를 추출."""
    rgb = np.asarray(rgb, dtype=np.float64)
    if rgb.ndim != 2 or rgb.shape[1] != 3:
        raise ValueError("rgb must have shape (N, 3)")

    mean = np.mean(rgb, axis=0)
    mean[mean == 0] = 1e-8
    cn = rgb / mean

    projection = np.array([[0.0, 1.0, -1.0], [-2.0, 1.0, 1.0]])
    s = cn @ projection.T
    s1, s2 = s[:, 0], s[:, 1]
    std2 = np.std(s2)
    alpha = np.std(s1) / std2 if std2 > 1e-8 else 0.0
    h = s1 + alpha * s2
    return h - np.mean(h)


def bandpass(signal: np.ndarray, fs: float, bpm_min: float, bpm_max: float, order: int = 3) -> np.ndarray:
    """BPM 범위에 해당하는 주파수만 남기는 Butterworth bandpass. (bpm_* 는 분당 단위)"""
    nyquist = 0.5 * fs
    low = max(0.01, bpm_min / 60.0) / nyquist
    high = min(bpm_max / 60.0 / nyquist, 0.99)
    if not 0 < low < high < 1:
        raise ValueError("invalid bandpass range")
    b, a = butter(order, [low, high], btype="band")
    return filtfilt(b, a, signal)


def reference_lowfreq_removal(
    signal: np.ndarray,
    reference: np.ndarray,
    fs: float,
    resp_band: Tuple[float, float] = RESP_REF_BAND_HZ,
) -> Tuple[np.ndarray, bool]:
    """
    [3순위] 참조 신호 기반 저주파 제거 (논문 4.1.2 '레이더 유도 저주파 제거'의 카메라 단독 근사).

    레이더 흉부 변위 대신 카메라 상체 optical-flow 호흡 신호를 저주파 참조로 사용한다.
    분석 창마다 rPPG(POS·detrend 후) 신호를 참조의 [호흡성분, 그 미분, 상수] 로 선형회귀하고,
    설명되는 성분(호흡 유발 기저선 드리프트)을 제거한 잔차를 반환한다.

    반환: (잔차 신호, 적용 여부). 참조가 부적절하면 원신호를 그대로 반환.
    """
    signal = np.asarray(signal, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)
    if reference.shape != signal.shape or len(signal) < 8 or np.std(reference) < 1e-9:
        return signal, False

    try:
        ref_lp = bandpass(reference, fs, resp_band[0] * 60.0, resp_band[1] * 60.0, order=2)
    except Exception:
        ref_lp = reference - np.mean(reference)

    if np.std(ref_lp) < 1e-9:
        return signal, False

    ref_lp = (ref_lp - ref_lp.mean()) / (ref_lp.std() + 1e-8)
    dref = np.gradient(ref_lp)
    design = np.column_stack([ref_lp, dref, np.ones_like(ref_lp)])
    try:
        coef, _, _, _ = np.linalg.lstsq(design, signal, rcond=None)
    except Exception:
        return signal, False
    residual = signal - design @ coef
    return residual, True


def _sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    z = math.exp(x)
    return z / (1.0 + z)


def _parabolic_peak_index(magnitude: np.ndarray, index: int) -> float:
    """스펙트럼 bin 주변 3점 보간으로 peak 위치를 소수점 bin으로 추정."""
    if index <= 0 or index >= len(magnitude) - 1:
        return float(index)
    left, center, right = magnitude[index - 1], magnitude[index], magnitude[index + 1]
    denom = left - 2.0 * center + right
    if abs(denom) < 1e-12:
        return float(index)
    delta = 0.5 * (left - right) / denom
    return float(index + np.clip(delta, -0.5, 0.5))


# --------------------------------------------------------------------------- #
# 스킨 마스크 & ROI 추출
# --------------------------------------------------------------------------- #
def skin_mask_ycrcb(
    bgr_roi: np.ndarray,
    *,
    cr_min: int = 133,
    cr_max: int = 173,
    cb_min: int = 77,
    cb_max: int = 127,
    y_min: float = 40.0,
    y_max: float = 250.0,
) -> np.ndarray:
    """BGR ROI에서 피부 픽셀 마스크(0/1 uint8). BT.601 로 YCrCb 직접 계산(cv2 불필요)."""
    roi = np.asarray(bgr_roi, dtype=np.float64)
    if roi.ndim != 3 or roi.shape[2] != 3:
        raise ValueError("bgr_roi must have shape (H, W, 3)")

    b = roi[:, :, 0]
    g = roi[:, :, 1]
    r = roi[:, :, 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cr = (r - y) * 0.713 + 128.0
    cb = (b - y) * 0.564 + 128.0
    mask = (cr >= cr_min) & (cr <= cr_max) & (cb >= cb_min) & (cb <= cb_max) & (y >= y_min) & (y <= y_max)
    return mask.astype(np.uint8)


def extract_roi_rgb(
    bgr_roi: np.ndarray,
    *,
    min_skin: int = DEFAULT_MIN_SKIN_PIXELS,
) -> Tuple[Optional[Tuple[float, float, float]], int, float, float]:
    """ROI에서 피부 픽셀만으로 평균 RGB 계산. 반환 (rgb|None, count, ratio, brightness)."""
    roi = np.asarray(bgr_roi)
    if roi.size == 0:
        return None, 0, 0.0, 0.0

    mask = skin_mask_ycrcb(roi)
    count = int(mask.sum())
    total = int(mask.size)
    skin_ratio = (count / total) if total else 0.0
    if count < min_skin:
        return None, count, skin_ratio, 0.0

    sel = mask.astype(bool)
    b = float(roi[:, :, 0][sel].mean())
    g = float(roi[:, :, 1][sel].mean())
    r = float(roi[:, :, 2][sel].mean())
    return (r, g, b), count, skin_ratio, (r + g + b) / 3.0


def build_hr_roi_candidates(
    face_box: Optional[Tuple[int, int, int, int]],
    width: int,
    height: int,
) -> List[Tuple[str, Tuple[int, int, int, int]]]:
    """face box에서 forehead/left_cheek/right_cheek 근사 박스. face 없으면 중앙 가이드 1개."""
    if face_box is None:
        gw, gh = int(width * 0.28), int(height * 0.20)
        box = ((width - gw) // 2, int(height * 0.22), gw, gh)
        return [("forehead", clamp_box(box, width, height))]

    x, y, w, h = face_box
    forehead = (x + int(0.30 * w), y + int(0.08 * h), int(0.40 * w), int(0.16 * h))
    left_cheek = (x + int(0.18 * w), y + int(0.42 * h), int(0.24 * w), int(0.22 * h))
    right_cheek = (x + int(0.58 * w), y + int(0.42 * h), int(0.24 * w), int(0.22 * h))
    return [
        ("forehead", clamp_box(forehead, width, height)),
        ("left_cheek", clamp_box(left_cheek, width, height)),
        ("right_cheek", clamp_box(right_cheek, width, height)),
    ]


def select_hr_roi(
    frame: np.ndarray,
    face_box: Optional[Tuple[int, int, int, int]],
    width: int,
    height: int,
    *,
    min_skin: int = DEFAULT_MIN_SKIN_PIXELS,
) -> RoiSample:
    """3개 ROI 후보 중 유효한 것을 피부픽셀 가중으로 결합. 지배 ROI 기준 center/ratio/brightness."""
    candidates = build_hr_roi_candidates(face_box, width, height)
    boxes: List[Tuple[str, Tuple[int, int, int, int], bool]] = []
    valid: List[dict] = []

    for name, box in candidates:
        rx, ry, rw, rh = box
        sub = frame[ry : ry + rh, rx : rx + rw]
        rgb, count, ratio, bright = extract_roi_rgb(sub, min_skin=min_skin)
        is_valid = rgb is not None
        boxes.append((name, box, is_valid))
        if is_valid:
            valid.append({
                "name": name, "rgb": np.array(rgb, dtype=np.float64), "count": count,
                "ratio": ratio, "brightness": bright, "center": (rx + rw / 2.0, ry + rh / 2.0),
            })

    if not valid:
        return RoiSample(None, 0, 0.0, 0.0, "none", None, boxes)

    weights = np.array([v["count"] for v in valid], dtype=np.float64)
    combined = np.average(np.stack([v["rgb"] for v in valid], axis=0), axis=0, weights=weights)
    dominant = max(valid, key=lambda v: v["count"])
    total_skin = int(sum(v["count"] for v in valid))
    roi_name = dominant["name"] if len(valid) == 1 else "multi"
    return RoiSample(
        rgb=(float(combined[0]), float(combined[1]), float(combined[2])),
        skin_pixel_count=total_skin,
        skin_ratio=float(dominant["ratio"]),
        brightness=float(dominant["brightness"]),
        roi_name=roi_name,
        center=dominant["center"],
        boxes=boxes,
    )


# --------------------------------------------------------------------------- #
# HR 추정 (Welch PSD + SQI + 선택적 저주파 제거)
# --------------------------------------------------------------------------- #
def _hr_hold_reason(status: str, e: "Estimate") -> str:
    if status != "ok":
        return {
            "collecting": "collecting samples", "warming_up": "warming up",
            "signal_error": "signal error", "flat_signal": "flat signal",
            "no_band": "no HR band", "low_roi": "low ROI quality",
        }.get(status, status)
    if e.q_motion < 0.6:
        return "motion/ROI jitter"
    if e.q_roi < 0.6:
        return "low ROI quality"
    if e.q_brightness < 1.0:
        return "lighting"
    if e.q_snr < 0.5 or e.q_energy < 0.5:
        return "low signal quality"
    return "low SQI"


def estimate_bpm(
    times: Iterable[float],
    rgb: Iterable[Iterable[float]],
    *,
    fs_resample: float = DEFAULT_FS_RESAMPLE,
    bpm_min: float = DEFAULT_BPM_MIN,
    bpm_max: float = DEFAULT_BPM_MAX,
    min_sec: float = DEFAULT_MIN_SEC,
    skin_ratio: float = 1.0,
    brightness: float = 128.0,
    jitter_norm: float = 0.0,
    sqi_gate: float = DEFAULT_HEART_SQI_GATE,
    ref_times: Optional[Iterable[float]] = None,
    ref_values: Optional[Iterable[float]] = None,
) -> Estimate:
    """
    타임스탬프 + (피부픽셀 가중) ROI RGB 시계열로 BPM과 SQI 추정.

    ref_times/ref_values 가 주어지면(=상체 호흡 참조), HR 대역 필터 직전에
    reference_lowfreq_removal 을 적용해 호흡 유발 저주파 드리프트를 선제 제거한다.
    """
    times_arr = np.asarray(list(times), dtype=np.float64)
    rgb_arr = np.asarray(list(rgb), dtype=np.float64)

    q_roi = float(np.clip(skin_ratio / DEFAULT_SKIN_RATIO_REF, 0.0, 1.0))
    q_brightness = 1.0 if 45.0 <= brightness <= 220.0 else 0.5
    q_motion = float(1.0 - DEFAULT_BETA_MOTION * float(np.clip(jitter_norm, 0.0, 1.0)))

    def _held(status: str, waveform: np.ndarray, duration: float) -> Estimate:
        e = Estimate(None, 0.0, waveform, status, duration,
                     q_roi=q_roi, q_brightness=q_brightness, q_motion=q_motion)
        e.hold_reason = _hr_hold_reason(status, e)
        return e

    if len(times_arr) < 30 or rgb_arr.shape[0] != len(times_arr):
        return _held("collecting", np.array([]), 0.0)

    duration = float(times_arr[-1] - times_arr[0])
    if duration < min_sec:
        return _held("warming_up", np.array([]), duration)

    n = max(int(duration * fs_resample), int(min_sec * fs_resample))
    t_uniform = np.linspace(times_arr[0], times_arr[-1], n)
    rgb_uniform = np.stack(
        [np.interp(t_uniform, times_arr, rgb_arr[:, ch]) for ch in range(3)], axis=1)

    try:
        pulse = pos_algorithm(rgb_uniform)
        pulse = detrend(pulse)
    except Exception:
        return _held("signal_error", np.array([]), duration)

    # [3순위] 참조 기반 저주파 제거 (HR 대역 필터 전에 적용)
    lowfreq_applied = False
    if ref_times is not None and ref_values is not None:
        rt = np.asarray(list(ref_times), dtype=np.float64)
        rv = np.asarray(list(ref_values), dtype=np.float64)
        if len(rt) >= 2 and len(rt) == len(rv):
            ref_uniform = np.interp(t_uniform, rt, rv)
            pulse, lowfreq_applied = reference_lowfreq_removal(pulse, ref_uniform, fs_resample)

    try:
        pulse = bandpass(pulse, fs_resample, bpm_min, bpm_max)
    except Exception:
        return _held("signal_error", np.array([]), duration)

    if not np.all(np.isfinite(pulse)) or np.std(pulse) < 1e-8:
        e = _held("flat_signal", pulse, duration)
        e.lowfreq_applied = lowfreq_applied
        return e

    pulse = (pulse - np.mean(pulse)) / (np.std(pulse) + 1e-8)

    nperseg = max(min(len(pulse), int(fs_resample * 8)), 16)
    noverlap = nperseg // 2
    freqs, psd = welch(pulse, fs=fs_resample, nperseg=nperseg, noverlap=noverlap, window="hann")

    band_mask = (freqs >= bpm_min / 60.0) & (freqs <= bpm_max / 60.0)
    band_indices = np.where(band_mask)[0]
    if len(band_indices) == 0:
        e = _held("no_band", pulse, duration)
        e.lowfreq_applied = lowfreq_applied
        return e

    local_peak = int(np.argmax(psd[band_indices]))
    peak_index = int(band_indices[local_peak])
    interp_index = _parabolic_peak_index(psd, peak_index)
    df = float(freqs[1] - freqs[0])
    bpm = float(interp_index * df * 60.0)

    band_values = psd[band_indices]
    exclude = np.abs(band_indices - peak_index) <= 2
    noise_values = band_values[~exclude]
    noise_floor = float(np.median(noise_values)) if len(noise_values) else float(np.median(band_values))
    peak_snr_db = float(10.0 * np.log10((psd[peak_index] + 1e-12) / (noise_floor + 1e-12)))

    full_mask = (freqs >= FULL_BAND_HZ[0]) & (freqs <= FULL_BAND_HZ[1])
    hr_band_energy_ratio = float(psd[band_mask].sum()) / (float(psd[full_mask].sum()) + 1e-12)

    q_snr = _sigmoid((peak_snr_db - 6.0) / 3.0)
    q_energy = float(np.clip(hr_band_energy_ratio, 0.0, 1.0))
    sqi = float(np.clip(
        (0.45 * q_snr + 0.30 * q_energy + 0.15 * q_roi + 0.10 * q_brightness) * q_motion, 0.0, 1.0))

    est = Estimate(
        bpm=bpm, sqi=sqi, waveform=pulse, status="ok", duration=duration,
        peak_snr_db=peak_snr_db, hr_band_energy_ratio=hr_band_energy_ratio,
        q_snr=q_snr, q_energy=q_energy, q_roi=q_roi, q_brightness=q_brightness,
        q_motion=q_motion, lowfreq_applied=lowfreq_applied,
    )
    if sqi < sqi_gate:
        est.hold_reason = _hr_hold_reason("ok", est)
    return est


# --------------------------------------------------------------------------- #
# 호흡 추정 (상체 움직임 기반 보조 지표)
# --------------------------------------------------------------------------- #
def estimate_respiration(
    times: Iterable[float],
    motion_values: Iterable[float],
    *,
    fs_resample: float = DEFAULT_RESP_FS_RESAMPLE,
    rpm_min: float = DEFAULT_RPM_MIN,
    rpm_max: float = DEFAULT_RPM_MAX,
    min_sec: float = DEFAULT_RESP_MIN_SEC,
) -> RespirationEstimate:
    """상체 ROI의 미세 움직임 시계열로 호흡수(RPM)를 추정 (보조 지표)."""
    times_arr = np.asarray(list(times), dtype=np.float64)
    motion_arr = np.asarray(list(motion_values), dtype=np.float64)

    if len(times_arr) < 30 or len(motion_arr) != len(times_arr):
        return RespirationEstimate(None, 0.0, np.array([]), "collecting", 0.0, "collecting samples")
    duration = float(times_arr[-1] - times_arr[0])
    if duration < min_sec:
        return RespirationEstimate(None, 0.0, np.array([]), "warming_up", duration, "warming up")

    n = max(int(duration * fs_resample), int(min_sec * fs_resample))
    t_uniform = np.linspace(times_arr[0], times_arr[-1], n)
    motion_uniform = np.interp(t_uniform, times_arr, motion_arr)

    try:
        signal = detrend(motion_uniform)
        signal = bandpass(signal, fs_resample, rpm_min, rpm_max, order=2)
    except Exception:
        return RespirationEstimate(None, 0.0, np.array([]), "signal_error", duration, "signal error")

    if not np.all(np.isfinite(signal)) or np.std(signal) < 1e-8:
        return RespirationEstimate(None, 0.0, signal, "flat_signal", duration, "flat signal")

    signal = (signal - np.mean(signal)) / (np.std(signal) + 1e-8)
    nperseg = max(min(len(signal), int(fs_resample * 12)), 16)
    noverlap = nperseg // 2
    freqs, psd = welch(signal, fs=fs_resample, nperseg=nperseg, noverlap=noverlap, window="hann")

    band_mask = (freqs >= rpm_min / 60.0) & (freqs <= rpm_max / 60.0)
    band_indices = np.where(band_mask)[0]
    if len(band_indices) == 0:
        return RespirationEstimate(None, 0.0, signal, "no_band", duration, "no RR band")

    local_peak = int(np.argmax(psd[band_indices]))
    peak_index = int(band_indices[local_peak])
    interp_index = _parabolic_peak_index(psd, peak_index)
    df = float(freqs[1] - freqs[0])
    rpm = float(interp_index * df * 60.0)

    band_values = psd[band_indices]
    exclude = np.abs(band_indices - peak_index) <= 2
    noise_values = band_values[~exclude]
    noise_floor = float(np.median(noise_values)) if len(noise_values) else float(np.median(band_values))
    snr_db = float(10.0 * np.log10((psd[peak_index] + 1e-12) / (noise_floor + 1e-12)))
    sqi = float(np.clip(_sigmoid((snr_db - 4.0) / 3.0), 0.0, 1.0))
    if peak_index == band_indices[0] or peak_index == band_indices[-1]:
        sqi *= 0.5
    return RespirationEstimate(rpm, sqi, signal, "ok", duration, "")


# --------------------------------------------------------------------------- #
# 보호자 알림 데모
# --------------------------------------------------------------------------- #
class DemoNotifier:
    """실제 발송 전 단계의 보호자 알림 데모를 CSV와 텍스트 파일로 남긴다."""

    def __init__(self, alert_log: str, inbox_path: str, cooldown_sec: float) -> None:
        self.alert_log = Path(alert_log) if alert_log else None
        self.inbox_path = Path(inbox_path) if inbox_path else None
        self.cooldown_sec = cooldown_sec
        self.last_sent_at = -1e9
        if self.alert_log:
            self.alert_log.parent.mkdir(parents=True, exist_ok=True)
            if not self.alert_log.exists():
                with self.alert_log.open("w", newline="", encoding="utf-8") as file:
                    csv.writer(file).writerow(
                        ["elapsed_sec", "event_type", "heart_bpm", "resp_rpm", "message"])

    def maybe_send(self, *, now: float, event_type: str, heart_bpm: Optional[float],
                   resp_rpm: Optional[float], message: str) -> bool:
        if now - self.last_sent_at < self.cooldown_sec:
            return False
        self.last_sent_at = now
        heart_text = "" if heart_bpm is None else f"{heart_bpm:.1f}"
        resp_text = "" if resp_rpm is None else f"{resp_rpm:.1f}"
        if self.alert_log:
            with self.alert_log.open("a", newline="", encoding="utf-8") as file:
                csv.writer(file).writerow([f"{now:.3f}", event_type, heart_text, resp_text, message])
        if self.inbox_path:
            self.inbox_path.parent.mkdir(parents=True, exist_ok=True)
            with self.inbox_path.open("a", encoding="utf-8") as file:
                file.write(f"[{now:7.1f}s] {event_type}: {message} HR={heart_text} RR={resp_text}\n")
        print(f"[DEMO ALERT] {event_type}: {message} HR={heart_text} BPM RR={resp_text} RPM")
        return True


# --------------------------------------------------------------------------- #
# Selftest
# --------------------------------------------------------------------------- #
def _band_energy(sig: np.ndarray, fs: float, band: Tuple[float, float]) -> float:
    f, psd = welch(sig, fs=fs, nperseg=min(len(sig), int(fs * 8)), window="hann")
    m = (f >= band[0]) & (f <= band[1])
    return float(psd[m].sum())


def selftest() -> bool:
    """합성 신호로 알고리즘 코어(스킨마스크, POS→Welch→SQI, 게이팅, 저주파 제거, 호흡)를 검증."""
    rng = np.random.default_rng(0)

    print("=== SELFTEST 1: skin mask (YCrCb) ===")
    skin = np.zeros((20, 20, 3), np.uint8); skin[:] = (120, 150, 200)
    nonskin = np.zeros((20, 20, 3), np.uint8); nonskin[:] = (200, 60, 40)
    mask_ok = int(skin_mask_ycrcb(skin).sum()) > 300 and int(skin_mask_ycrcb(nonskin).sum()) < 50
    print(f"  {'OK' if mask_ok else 'XX'} skin detected & blue rejected")

    print("=== SELFTEST 2: POS -> Welch -> SQI BPM ===")
    ok_count = 0
    test_bpms = [55, 72, 90, 120, 150]
    for true_bpm in test_bpms:
        fs = 30.0; t = np.arange(0, 14.0, 1.0 / fs)
        pulse = np.sin(2 * np.pi * (true_bpm / 60.0) * t)
        drift = 0.015 * np.sin(2 * np.pi * 0.08 * t)
        rgb = np.array([0.60, 0.50, 0.42])[None, :] + np.outer(pulse, [0.010, 0.030, 0.015]) + drift[:, None]
        rgb += rng.normal(0, 0.004, size=rgb.shape)
        est = estimate_bpm(t, rgb, min_sec=8.0, bpm_max=180.0)
        err = float("inf") if est.bpm is None else abs(est.bpm - true_bpm)
        passed = err <= 3.0 and est.sqi >= 0.50
        ok_count += int(passed)
        print(f"  {'OK' if passed else 'XX'} true={true_bpm:3d} est={'None' if est.bpm is None else f'{est.bpm:6.1f}'} "
              f"err={err:4.1f} sqi={est.sqi:.2f}")
    heart_ok = ok_count == len(test_bpms)
    print(f"  pass: {ok_count}/{len(test_bpms)}")

    print("=== SELFTEST 3: SQI gating on degraded input ===")
    t = np.arange(0, 14.0, 1.0 / 30.0)
    pulse = np.sin(2 * np.pi * (72 / 60.0) * t)
    rgb = np.array([0.6, 0.5, 0.42])[None, :] + np.outer(pulse, [0.01, 0.03, 0.015]) + rng.normal(0, 0.004, (len(t), 3))
    hi = estimate_bpm(t, rgb, jitter_norm=0.0)
    lo = estimate_bpm(t, rgb, jitter_norm=1.0, skin_ratio=0.05, brightness=10.0)
    gate_ok = hi.sqi >= 0.50 and lo.sqi < 0.50 and lo.hold_reason != ""
    print(f"  {'OK' if gate_ok else 'XX'} clean sqi={hi.sqi:.2f} / degraded sqi={lo.sqi:.2f} hold='{lo.hold_reason}'")

    print("=== SELFTEST 4: reference low-freq removal (radar-guided surrogate) ===")
    fs = 30.0; t = np.arange(0, 14.0, 1.0 / fs)
    resp = np.sin(2 * np.pi * 0.25 * t)                 # 15 rpm 호흡
    hr = np.sin(2 * np.pi * 1.2 * t)                    # 72 bpm
    contaminated = hr + 4.0 * resp + 0.3 * np.gradient(resp)   # 호흡 유발 저주파가 크게 오염
    clean_resid, applied = reference_lowfreq_removal(detrend(contaminated), resp, fs)
    e_before = _band_energy(detrend(contaminated), fs, RESP_REF_BAND_HZ)
    e_after = _band_energy(clean_resid, fs, RESP_REF_BAND_HZ)
    hr_before = _band_energy(detrend(contaminated), fs, (0.7, 3.0))
    hr_after = _band_energy(clean_resid, fs, (0.7, 3.0))
    resp_drop = e_after < 0.25 * e_before
    hr_kept = hr_after > 0.6 * hr_before
    lf_ok = applied and resp_drop and hr_kept
    print(f"  {'OK' if lf_ok else 'XX'} resp-band energy {e_before:.2f}->{e_after:.2f} ({100*e_after/e_before:.0f}%), "
          f"HR-band kept {100*hr_after/hr_before:.0f}%")

    print("=== SELFTEST 5: motion -> respiration ===")
    resp_ok_count = 0
    for true_rpm in [9, 14, 20, 26]:
        fs = 10.0; t = np.arange(0, 32.0, 1.0 / fs)
        motion = 0.8 * np.sin(2 * np.pi * (true_rpm / 60.0) * t) + 0.15 * np.sin(2 * np.pi * 0.03 * t)
        motion += rng.normal(0, 0.08, size=motion.shape)
        est = estimate_respiration(t, motion, min_sec=18.0)
        err = float("inf") if est.rpm is None else abs(est.rpm - true_rpm)
        passed = err <= 2.0
        resp_ok_count += int(passed)
        print(f"  {'OK' if passed else 'XX'} true={true_rpm:3d} est={'None' if est.rpm is None else f'{est.rpm:6.1f}'} err={err:4.1f}")
    resp_ok = resp_ok_count == 4

    all_ok = mask_ok and heart_ok and gate_ok and lf_ok and resp_ok
    print(f"\n=== SELFTEST RESULT: {'PASS' if all_ok else 'FAIL'} ===")
    return all_ok


# --------------------------------------------------------------------------- #
# 카메라/기하 유틸
# --------------------------------------------------------------------------- #
def build_face_detector(cv2):
    try:
        det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        return None if det.empty() else det
    except Exception:
        return None


def open_camera(cv2, camera_index: int, width: int, height: int):
    backends = []
    if platform.system().lower().startswith("win"):
        backends.extend([cv2.CAP_DSHOW, cv2.CAP_MSMF])
    backends.append(0)
    for backend in backends:
        cap = cv2.VideoCapture(camera_index, backend) if backend else cv2.VideoCapture(camera_index)
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            return cap
        cap.release()
    return None


def prune_by_time(times: Deque[float], rgbs: Deque, max_age_sec: float, now: float) -> None:
    while times and (now - times[0]) > max_age_sec:
        times.popleft(); rgbs.popleft()


def prune_scalar_by_time(times: Deque[float], values: Deque[float], max_age_sec: float, now: float) -> None:
    while times and (now - times[0]) > max_age_sec:
        times.popleft(); values.popleft()


def clamp_box(box: Tuple[int, int, int, int], width: int, height: int) -> Tuple[int, int, int, int]:
    x, y, w, h = box
    x = max(0, min(int(x), width - 1))
    y = max(0, min(int(y), height - 1))
    w = max(1, min(int(w), width - x))
    h = max(1, min(int(h), height - y))
    return x, y, w, h


def chest_visible(face_box: Optional[Tuple[int, int, int, int]], height: int) -> bool:
    if face_box is None:
        return True
    _, y, _, h = face_box
    return (y + h) < height * 0.72


def build_respiration_box(face_box, width: int, height: int) -> Tuple[int, int, int, int]:
    if face_box is not None:
        x, y, w, h = face_box
        box_w = int(w * 1.45); box_h = int(h * 0.58)
        box_x = int(x + w * 0.5 - box_w * 0.5); box_y = int(y + h * 1.45)
        return clamp_box((box_x, box_y, box_w, box_h), width, height)
    gw, gh = int(width * 0.48), int(height * 0.20)
    return clamp_box(((width - gw) // 2, int(height * 0.66), gw, gh), width, height)


SQI_RELIABLE_THRESHOLD = 0.70


def sqi_label(sqi: float, gate: float) -> str:
    if sqi >= SQI_RELIABLE_THRESHOLD:
        return "Reliable"
    if sqi >= gate:
        return "Usable"
    return "Hold"


def hysteresis_label(sqi: float, gate: float, prev_label: str, margin: float) -> str:
    """Reliable/Usable/Hold 전환에 dead-band를 둬서, 경계값 근처를 오가는 SQI 노이즈로
    배지가 0.5초마다 빠르게 깜빡이는 것을 막는다. raw SQI/CSV 로깅/HR 표시 게이트 자체는
    그대로 두고 화면에 보여주는 라벨만 안정화하는 용도.
    """
    if prev_label == "Hold":
        if sqi >= gate + margin:
            return "Reliable" if sqi >= SQI_RELIABLE_THRESHOLD else "Usable"
        return "Hold"
    if prev_label == "Usable":
        if sqi < gate - margin:
            return "Hold"
        if sqi >= SQI_RELIABLE_THRESHOLD + margin:
            return "Reliable"
        return "Usable"
    # prev_label == "Reliable"
    if sqi < gate - margin:
        return "Hold"
    if sqi < SQI_RELIABLE_THRESHOLD - margin:
        return "Usable"
    return "Reliable"


def _label_color_text(label: str) -> Tuple[Tuple[int, int, int], str]:
    if label == "Reliable":
        return UI_GOOD, "신뢰 가능"
    if label == "Usable":
        return UI_WARNING, "사용 가능"
    return UI_CRITICAL, "보류"


def draw_camera_overlay(cv2, frame_bgr: np.ndarray, roi_boxes, resp_box, resp_ok: bool) -> np.ndarray:
    """카메라 프레임 위에 ROI 한글 라벨(Pillow)을 입힌다. cv2.putText는 한글을 못 그려서 별도 처리."""
    img = Image.fromarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
    d = ImageDraw.Draw(img, "RGBA")

    def tag(text, cx, top, above=True, color=(230, 230, 230)):
        tw = d.textlength(text, font=_UI_F_TAG)
        pad = 5
        box_w, box_h = tw + pad * 2, 20
        bx0 = cx - box_w / 2
        by0 = (top - box_h - 4) if above else (top + 4)
        d.rectangle((bx0, by0, bx0 + box_w, by0 + box_h), fill=(0, 0, 0, 140))
        d.text((bx0 + pad, by0 + 3), text, font=_UI_F_TAG, fill=color)

    for name, (rx, ry, rw, rh), is_valid in roi_boxes:
        if not is_valid or name != "forehead":
            continue
        tag("이마 ROI", rx + rw / 2, ry, above=True)

    if resp_box is not None:
        bx, by, bw, bh = resp_box
        if resp_ok:
            tag("호흡 ROI (가슴)", bx + bw / 2, by + bh, above=False)
        else:
            tag("가슴을 박스 안에 두세요", bx + bw / 2, by + bh, above=False, color=(255, 200, 140))

    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def draw_panel(
    hr_bpm: Optional[float], hr_sqi: float, hr_label: str, hr_lowfreq: bool,
    rr_rpm: Optional[float], rr_sqi: float, rr_label: str,
    waveform: np.ndarray, roi_name: str, skin_ratio: float, fps: float, height: int,
    alert_text: str, alert_color: Tuple[int, int, int],
) -> Image.Image:
    s = UI_SCALE
    img = Image.new("RGB", (UI_PANEL_W * s, height * s), UI_SURFACE)
    d = ImageDraw.Draw(img)
    x = 14 * s
    y = 12 * s
    w = (UI_PANEL_W - 28) * s

    # --- HR ---
    hr_color, hr_text = _label_color_text(hr_label)
    d.ellipse((x, y + 4 * s, x + 7 * s, y + 11 * s), fill=hr_color)
    label = "심박수 HR" + ("  (LF)" if hr_lowfreq else "")
    d.text((x + 13 * s, y), label, font=_UI_F_LABEL, fill=UI_INK_SEC)
    y += 20 * s
    hr_str = f"{hr_bpm:.0f}" if hr_bpm is not None else "--"
    d.text((x, y), hr_str, font=_UI_F_HERO, fill=UI_INK)
    hw = d.textlength(hr_str, font=_UI_F_HERO)
    d.text((x + hw + 8 * s, y + _UI_HERO_LINE_H * 0.45), "BPM", font=_UI_F_UNIT, fill=UI_INK_SEC)
    y = y + _UI_HERO_LINE_H + 8 * s
    badge_w = 10 * s + d.textlength(hr_text, font=_UI_F_BADGE) + 10 * s
    d.rounded_rectangle((x, y, x + badge_w, y + 22 * s), radius=11 * s, fill=(46, 46, 44))
    d.ellipse((x + 8 * s, y + 9 * s, x + 13 * s, y + 14 * s), fill=hr_color)
    d.text((x + 18 * s, y + 4 * s), hr_text, font=_UI_F_BADGE, fill=hr_color)
    y += 24 * s
    d.rounded_rectangle((x, y, x + w, y + 6 * s), 3 * s, fill=UI_TRACK)
    frac = 0.0 if hr_sqi is None else max(0.0, min(1.0, hr_sqi))
    if frac > 0:
        d.rounded_rectangle((x, y, x + w * frac, y + 6 * s), 3 * s, fill=hr_color)
    d.text((x + w - 24 * s, y + 9 * s), f"{frac*100:.0f}", font=_UI_F_LABEL, fill=UI_INK_SEC)
    d.text((x, y + 9 * s), "SQI", font=_UI_F_LABEL, fill=UI_INK_SEC)
    y += 20 * s
    d.line((x, y, x + w, y), fill=UI_HAIRLINE, width=1)
    y += 8 * s

    # --- RR ---
    rr_color, rr_text = _label_color_text(rr_label)
    d.ellipse((x, y + 4 * s, x + 7 * s, y + 11 * s), fill=rr_color)
    d.text((x + 13 * s, y), "호흡수 RR (보조지표)", font=_UI_F_LABEL, fill=UI_INK_SEC)
    y += 20 * s
    rr_str = f"{rr_rpm:.0f}" if rr_rpm is not None else "--"
    d.text((x, y), rr_str, font=_UI_F_RR, fill=UI_INK)
    rw_px = d.textlength(rr_str, font=_UI_F_RR)
    d.text((x + rw_px + 6 * s, y + _UI_RR_LINE_H * 0.42), "RPM", font=_UI_F_UNIT, fill=UI_INK_SEC)
    badge_w2 = 10 * s + d.textlength(rr_text, font=_UI_F_BADGE) + 10 * s
    bx0 = x + w - badge_w2
    badge_top = y + (_UI_RR_LINE_H - 22 * s) / 2
    d.rounded_rectangle((bx0, badge_top, x + w, badge_top + 22 * s), radius=11 * s, fill=(46, 46, 44))
    d.ellipse((bx0 + 8 * s, badge_top + 7 * s, bx0 + 13 * s, badge_top + 12 * s), fill=rr_color)
    d.text((bx0 + 18 * s, badge_top + 2 * s), rr_text, font=_UI_F_BADGE, fill=rr_color)
    y = y + _UI_RR_LINE_H + 8 * s
    d.rounded_rectangle((x, y, x + w, y + 6 * s), 3 * s, fill=UI_TRACK)
    frac_r = 0.0 if rr_sqi is None else max(0.0, min(1.0, rr_sqi))
    if frac_r > 0:
        d.rounded_rectangle((x, y, x + w * frac_r, y + 6 * s), 3 * s, fill=rr_color)
    d.text((x + w - 24 * s, y + 9 * s), f"{frac_r*100:.0f}", font=_UI_F_LABEL, fill=UI_INK_SEC)
    d.text((x, y + 9 * s), "SQI", font=_UI_F_LABEL, fill=UI_INK_SEC)
    y += 20 * s
    d.line((x, y, x + w, y), fill=UI_HAIRLINE, width=1)
    y += 8 * s

    # --- waveform ---
    d.text((x, y), "맥파 파형", font=_UI_F_LABEL, fill=UI_INK_SEC)
    y += 14 * s
    wf_h = 28 * s
    if waveform is not None and waveform.size > 5:
        seg = waveform[-min(len(waveform), UI_PANEL_W - 28):]
        seg = seg / (np.max(np.abs(seg)) + 1e-8)
        pts = []
        for i, v in enumerate(seg):
            px = x + i * w / len(seg)
            py = y + wf_h / 2 - v * wf_h * 0.42
            pts.append((px, py))
        if len(pts) >= 2:
            d.line(pts, fill=UI_ACCENT, width=2 * s, joint="curve")
    y += wf_h + 6 * s
    d.line((x, y, x + w, y), fill=UI_HAIRLINE, width=1)
    y += 8 * s

    # --- ROI info ---
    d.text((x, y), "ROI / 신호 정보", font=_UI_F_LABEL, fill=UI_INK_SEC)
    y += 16 * s
    d.text((x, y), f"ROI  {roi_name}", font=_UI_F_INFO, fill=UI_INK)
    y += 16 * s
    d.text((x, y), f"피부 비율  {skin_ratio*100:.0f}%", font=_UI_F_INFO, fill=UI_INK)
    y += 16 * s
    d.text((x, y), f"FPS  {fps:.0f}", font=_UI_F_INFO, fill=UI_INK)
    y += 18 * s
    d.line((x, y, x + w, y), fill=UI_HAIRLINE, width=1)
    y += 8 * s

    # --- 보호자 알림 ---
    d.text((x, y), "보호자 알림", font=_UI_F_LABEL, fill=UI_INK_SEC)
    y += 16 * s
    d.text((x, y), alert_text, font=_UI_F_INFO, fill=alert_color)
    y += 15 * s

    # --- footer: 바닥에 고정. 위 내용이 길어지면 자연 흐름으로 밀려남(겹침 방지) ---
    footer_y = max(y + 8 * s, height * s - 34 * s)
    d.text((x, footer_y), "데모용 · 의료기기 아님", font=_UI_F_FOOT, fill=UI_INK_MUTED)
    d.text((x, footer_y + 15 * s), "SpO2 · 혈압 미구현", font=_UI_F_FOOT, fill=UI_INK_MUTED)

    return img


def fit_to_window(cv2, canvas: np.ndarray, win_name: str) -> np.ndarray:
    """창 크기(최대화/리사이즈 포함)에 맞춰 비율 유지 확대/축소하고 남는 공간은 레터박스 처리."""
    ch, cw = canvas.shape[:2]
    try:
        _, _, rw, rh = cv2.getWindowImageRect(win_name)
    except Exception:
        rw, rh = cw, ch
    if rw <= 0 or rh <= 0:
        return canvas
    scale = min(rw / cw, rh / ch)
    nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    resized = cv2.resize(canvas, (nw, nh), interpolation=interp)
    out = np.full((rh, rw, 3), UI_SURFACE_BGR, dtype=np.uint8)
    ox, oy = (rw - nw) // 2, (rh - nh) // 2
    out[oy:oy + nh, ox:ox + nw] = resized
    return out


def _maybe_facemesh_engine(use_facemesh: bool, min_skin: int):
    """--use-facemesh 시 roi_facemesh 엔진을 만든다. 실패하면 (None, 사유)."""
    if not use_facemesh:
        return None, ""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import roi_facemesh
        if not roi_facemesh.is_available():
            return None, "mediapipe 미설치 - Haar ROI로 폴백 (pip install mediapipe)"
        return roi_facemesh.FaceMeshCheekROI(min_skin=min_skin), ""
    except Exception as exc:
        return None, f"facemesh 초기화 실패({exc}) - Haar ROI로 폴백"


# --------------------------------------------------------------------------- #
# 메인 웹캠 루프
# --------------------------------------------------------------------------- #
def run_webcam(args: argparse.Namespace) -> None:
    import cv2

    detector = build_face_detector(cv2)
    cap = open_camera(cv2, args.camera, args.width, args.height)
    if cap is None:
        raise RuntimeError("웹캠을 열 수 없습니다. 카메라 권한 또는 다른 앱의 카메라 사용 여부를 확인하세요.")

    facemesh_engine, fm_msg = _maybe_facemesh_engine(args.use_facemesh, args.min_skin_pixels)
    if fm_msg:
        print(f"[facemesh] {fm_msg}")
    elif facemesh_engine is not None:
        print("[facemesh] MediaPipe 볼 다각형 ROI 사용")

    if args.lock_exposure and not args.force_lock_exposure:
        print("--lock-exposure: 이 카메라에서는 화면이 어두워질 수 있어 자동 고정을 건너뜁니다. (--force-lock-exposure 로 강제)")
    elif args.lock_exposure:
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_AUTO_WB, 0)

    times: Deque[float] = deque(); rgbs: Deque[Tuple[float, float, float]] = deque()
    resp_times: Deque[float] = deque(); resp_motion: Deque[float] = deque()

    disp_bpm: Optional[float] = None; disp_rpm: Optional[float] = None
    last_update = 0.0
    last_estimate = Estimate(None, 0.0, np.array([]), "collecting", 0.0, hold_reason="collecting samples")
    last_resp_estimate = RespirationEstimate(None, 0.0, np.array([]), "collecting", 0.0, "collecting samples")
    hr_label_state = "Hold"; resp_label_state = "Hold"  # 배지 표시 안정화(히스테리시스) 상태

    prev_center: Optional[Tuple[float, float]] = None
    jitter_px = 0.0; jitter_norm_ema = 0.0
    last_roi_name = "none"; last_skin_count = 0; last_skin_ratio = 0.0; last_brightness = 0.0

    alert_since = {"heart": None, "resp": None}
    active_alert_message = ""
    prev_resp_gray: Optional[np.ndarray] = None
    resp_chest_ok = True
    notifier = DemoNotifier(args.alert_log, args.alert_inbox, args.alert_cooldown_sec)

    # [5순위] 프로파일링 상태
    fps_ema = 0.0; prev_frame_t = None
    latencies: List[float] = []; fps_samples: List[float] = []

    csv_file = None; csv_writer = None
    if args.log:
        csv_file = open(args.log, "w", newline="", encoding="utf-8")
        csv_writer = csv.writer(csv_file)
        csv_writer.writerow([
            "elapsed_sec", "heart_bpm", "heart_sqi", "heart_status", "heart_hold_reason",
            "resp_rpm", "resp_sqi", "resp_status", "resp_hold_reason",
            "roi_name", "skin_pixel_count", "skin_ratio", "brightness", "roi_jitter_px",
            # [4순위] SQI 구성요소 + 저주파 + 시나리오 + fps
            "peak_snr_db", "hr_band_energy_ratio", "q_snr", "q_energy", "q_motion",
            "lowfreq_applied", "scenario", "fps",
            "heart_alert", "resp_alert",
        ])

    cv2.namedWindow(UI_WIN_NAME, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(UI_WIN_NAME, args.width + UI_PANEL_W, args.height)

    start = time.time()
    print(f"데모 시작 (scenario={args.scenario or 'none'}, lowfreq_ref={args.lowfreq_ref}). "
          f"얼굴을 화면에 두고 8~12초 가만히. 종료 q/ESC.")
    print("주의: 연구/시연용이며 의료 판단용이 아닙니다. SpO2/혈압 미구현.")

    try:
        while True:
            loop_t0 = time.time()
            ok, frame = cap.read()
            if not ok:
                break
            frame = cv2.flip(frame, 1)
            if args.bright != 1.0:
                frame = cv2.convertScaleAbs(frame, alpha=args.bright, beta=0)

            height, width = frame.shape[:2]
            now = time.time() - start

            if prev_frame_t is not None:
                dt = loop_t0 - prev_frame_t
                if dt > 0:
                    inst = 1.0 / dt
                    fps_ema = inst if fps_ema == 0 else 0.9 * fps_ema + 0.1 * inst
                    fps_samples.append(inst)
            prev_frame_t = loop_t0

            face_box = None; face_found = False
            if detector is not None:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = detector.detectMultiScale(gray, 1.2, 5, minSize=(110, 110))
                if len(faces) > 0:
                    x, y, w, h = max(faces, key=lambda it: it[2] * it[3])
                    face_box = (int(x), int(y), int(w), int(h)); face_found = True
                    cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 180, 0), 1)

            # --- HR ROI 선택: facemesh 우선, 실패/미사용 시 Haar ---
            roi_sample = None
            if facemesh_engine is not None:
                try:
                    roi_sample = facemesh_engine.sample(frame)
                except Exception:
                    roi_sample = None
            if roi_sample is None:
                roi_sample = select_hr_roi(frame, face_box, width, height, min_skin=args.min_skin_pixels)

            for _, (rx, ry, rw, rh), is_valid in getattr(roi_sample, "boxes", []):
                cv2.rectangle(frame, (rx, ry), (rx + rw, ry + rh), UI_ACCENT_BGR if is_valid else (80, 80, 80), 2)
            for _, poly, _ in getattr(roi_sample, "polygons", []):
                cv2.polylines(frame, [np.asarray(poly, np.int32)], True, (0, 255, 255), 1)

            if roi_sample.center is not None:
                if prev_center is not None:
                    jitter_px = float(np.hypot(roi_sample.center[0] - prev_center[0],
                                               roi_sample.center[1] - prev_center[1]))
                prev_center = roi_sample.center
            jitter_norm = float(np.clip(jitter_px / args.jitter_scale_px, 0.0, 1.0))
            jitter_norm_ema = 0.7 * jitter_norm_ema + 0.3 * jitter_norm

            if roi_sample.rgb is not None:
                times.append(now); rgbs.append(roi_sample.rgb)
                last_roi_name = roi_sample.roi_name; last_skin_count = roi_sample.skin_pixel_count
                last_skin_ratio = roi_sample.skin_ratio; last_brightness = roi_sample.brightness
            else:
                last_roi_name = "none"; last_skin_count = roi_sample.skin_pixel_count
                last_skin_ratio = roi_sample.skin_ratio

            # --- 호흡 ROI (상체 움직임) ---
            resp_chest_ok = chest_visible(face_box, height)
            bx, by, bw, bh = build_respiration_box(face_box, width, height)
            cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), UI_WARNING_BGR, 2)
            resp_roi = frame[by : by + bh, bx : bx + bw]
            if resp_chest_ok and resp_roi.size > 0 and bw >= 24 and bh >= 16:
                rg = cv2.cvtColor(resp_roi, cv2.COLOR_BGR2GRAY)
                rg = cv2.GaussianBlur(cv2.resize(rg, (96, 48), interpolation=cv2.INTER_AREA), (5, 5), 0)
                if prev_resp_gray is not None and prev_resp_gray.shape == rg.shape:
                    flow = cv2.calcOpticalFlowFarneback(prev_resp_gray, rg, None, 0.5, 2, 15, 2, 5, 1.1, 0)
                    resp_times.append(now); resp_motion.append(float(np.mean(flow[:, :, 1])))
                prev_resp_gray = rg
            else:
                prev_resp_gray = None

            prune_by_time(times, rgbs, args.window_sec, now)
            prune_scalar_by_time(resp_times, resp_motion, args.resp_window_sec, now)

            if now - last_update >= args.update_sec:
                last_update = now

                # [3순위] 저주파 참조: --lowfreq-ref 이고 호흡 버퍼 충분할 때만
                ref_t = ref_v = None
                if args.lowfreq_ref and len(resp_times) >= 5:
                    ref_t = list(resp_times); ref_v = list(resp_motion)

                last_estimate = estimate_bpm(
                    times, rgbs, fs_resample=args.fs, bpm_min=args.bpm_min, bpm_max=args.bpm_max,
                    min_sec=args.min_sec, skin_ratio=last_skin_ratio,
                    brightness=last_brightness if last_brightness > 0 else 128.0,
                    jitter_norm=jitter_norm_ema, sqi_gate=args.heart_sqi_gate,
                    ref_times=ref_t, ref_values=ref_v,
                )

                heart_hold_reason = last_estimate.hold_reason
                if last_estimate.bpm is not None and last_estimate.sqi >= args.heart_sqi_gate:
                    cand = last_estimate.bpm
                    if disp_bpm is not None:
                        max_step = 20.0 if last_estimate.sqi >= 0.75 else 12.0
                        if abs(cand - disp_bpm) > max_step:
                            cand = disp_bpm + math.copysign(max_step, cand - disp_bpm)
                    disp_bpm = cand if disp_bpm is None else (1 - args.smooth_alpha) * disp_bpm + args.smooth_alpha * cand
                    heart_hold_reason = ""

                if not resp_chest_ok:
                    last_resp_estimate = RespirationEstimate(None, 0.0, np.array([]), "hold",
                                                             last_resp_estimate.duration, "chest ROI not visible")
                    resp_hold_reason = "chest ROI not visible"
                else:
                    last_resp_estimate = estimate_respiration(
                        resp_times, resp_motion, fs_resample=args.resp_fs,
                        rpm_min=args.rpm_min, rpm_max=args.rpm_max, min_sec=args.resp_min_sec)
                    resp_hold_reason = last_resp_estimate.hold_reason
                    if last_resp_estimate.rpm is not None and last_resp_estimate.sqi >= args.resp_sqi_gate:
                        disp_rpm = last_resp_estimate.rpm if disp_rpm is None else (
                            (1 - args.smooth_alpha) * disp_rpm + args.smooth_alpha * last_resp_estimate.rpm)
                        resp_hold_reason = ""
                    elif not resp_hold_reason:
                        resp_hold_reason = "low RR SQI"

                hr_label_state = hysteresis_label(
                    last_estimate.sqi, args.heart_sqi_gate, hr_label_state, args.sqi_hysteresis)
                resp_label_state = hysteresis_label(
                    last_resp_estimate.sqi, args.resp_sqi_gate, resp_label_state, args.sqi_hysteresis)

                heart_alert = False
                if disp_bpm is not None and last_estimate.sqi >= args.heart_sqi_gate:
                    heart_alert = disp_bpm < args.low_bpm or disp_bpm > args.high_bpm
                    alert_since["heart"] = now if (heart_alert and alert_since["heart"] is None) else (
                        alert_since["heart"] if heart_alert else None)
                else:
                    alert_since["heart"] = None
                resp_alert = False
                if disp_rpm is not None and last_resp_estimate.sqi >= args.resp_sqi_gate and resp_chest_ok:
                    resp_alert = disp_rpm < args.low_rpm or disp_rpm > args.high_rpm
                    alert_since["resp"] = now if (resp_alert and alert_since["resp"] is None) else (
                        alert_since["resp"] if resp_alert else None)
                else:
                    alert_since["resp"] = None

                sustained_heart = alert_since["heart"] is not None and (now - alert_since["heart"]) >= args.alert_sustain_sec
                sustained_resp = alert_since["resp"] is not None and (now - alert_since["resp"]) >= args.alert_sustain_sec
                active_alert_message = ""
                if sustained_heart:
                    active_alert_message = "heart rate outside demo threshold"
                    notifier.maybe_send(now=now, event_type="heart_rate_alert",
                                        heart_bpm=disp_bpm, resp_rpm=disp_rpm, message=active_alert_message)
                if sustained_resp:
                    active_alert_message = "respiration rate outside demo threshold"
                    notifier.maybe_send(now=now, event_type="respiration_alert",
                                        heart_bpm=disp_bpm, resp_rpm=disp_rpm, message=active_alert_message)

                if csv_writer is not None:
                    e = last_estimate
                    csv_writer.writerow([
                        f"{now:.3f}",
                        "" if disp_bpm is None else f"{disp_bpm:.2f}",
                        f"{e.sqi:.3f}", e.status, heart_hold_reason,
                        "" if disp_rpm is None else f"{disp_rpm:.2f}",
                        f"{last_resp_estimate.sqi:.3f}", last_resp_estimate.status, resp_hold_reason,
                        last_roi_name, last_skin_count, f"{last_skin_ratio:.3f}",
                        f"{last_brightness:.1f}", f"{jitter_px:.2f}",
                        f"{e.peak_snr_db:.2f}", f"{e.hr_band_energy_ratio:.3f}",
                        f"{e.q_snr:.3f}", f"{e.q_energy:.3f}", f"{e.q_motion:.3f}",
                        int(e.lowfreq_applied), args.scenario, f"{fps_ema:.1f}",
                        int(sustained_heart), int(sustained_resp),
                    ])
                    csv_file.flush()

            # --------------- UI (사이드 패널) ---------------
            e = last_estimate
            re = last_resp_estimate
            roi_tag = f"{last_roi_name}{'(mesh)' if facemesh_engine is not None else ''}"

            pending = []
            if alert_since["heart"] is not None:
                pending.append(max(0.0, args.alert_sustain_sec - (now - alert_since["heart"])))
            if alert_since["resp"] is not None:
                pending.append(max(0.0, args.alert_sustain_sec - (now - alert_since["resp"])))
            if active_alert_message:
                alert_text, alert_color = "이상 감지 - 보호자 알림 전송됨", UI_CRITICAL
            elif pending:
                alert_text = f"이상 감지 중 · {min(pending):.0f}초 후 알림"
                alert_color = UI_WARNING
            else:
                alert_text, alert_color = "이상 없음 · 지속 관찰 중", UI_INK

            hr_bpm_for_panel = disp_bpm if (disp_bpm is not None and hr_label_state != "Hold") else None
            rr_rpm_for_panel = disp_rpm if (disp_rpm is not None and resp_label_state != "Hold"
                                             and resp_chest_ok) else None

            frame = draw_camera_overlay(cv2, frame, getattr(roi_sample, "boxes", []), (bx, by, bw, bh), resp_chest_ok)

            frame_hi = cv2.resize(frame, (width * UI_SCALE, height * UI_SCALE), interpolation=cv2.INTER_CUBIC)
            canvas = cv2.copyMakeBorder(frame_hi, 0, 0, 0, UI_PANEL_W * UI_SCALE,
                                        cv2.BORDER_CONSTANT, value=UI_SURFACE_BGR)
            panel = draw_panel(
                hr_bpm_for_panel, e.sqi, hr_label_state, bool(e.lowfreq_applied),
                rr_rpm_for_panel, re.sqi, resp_label_state,
                e.waveform, roi_tag, last_skin_ratio, fps_ema, height,
                alert_text, alert_color,
            )
            panel_bgr = cv2.cvtColor(np.array(panel), cv2.COLOR_RGB2BGR)
            canvas[:, width * UI_SCALE:width * UI_SCALE + UI_PANEL_W * UI_SCALE] = panel_bgr

            cv2.imshow(UI_WIN_NAME, fit_to_window(cv2, canvas, UI_WIN_NAME))

            latencies.append((time.time() - loop_t0) * 1000.0)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if args.duration > 0 and now >= args.duration:
                print(f"--duration {args.duration:.0f}s 경과, 자동 종료.")
                break
    finally:
        cap.release()
        try:
            cv2.destroyAllWindows()
        except Exception:
            pass
        if csv_file is not None:
            csv_file.close()
        if facemesh_engine is not None:
            facemesh_engine.close()
        if args.profile and fps_samples:
            fa = np.asarray(fps_samples); la = np.asarray(latencies)
            print("\n=== PROFILE ===")
            print(f"  frames={len(fa)}  FPS mean={fa.mean():.1f} min={fa.min():.1f} p05={np.percentile(fa,5):.1f}")
            print(f"  per-frame latency mean={la.mean():.1f}ms p95={np.percentile(la,95):.1f}ms")
            print(f"  목표(기획서 6.3): 실시간 10~15 FPS 이상 -> {'충족' if fa.mean() >= 10 else '미달, ROI/해상도 경량화 필요'}")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TouchFree Vitals (TIENG) rPPG webcam demo v4 (확장판)")
    p.add_argument("--selftest", action="store_true", help="카메라 없이 합성 신호로 알고리즘 검증")
    p.add_argument("--camera", type=int, default=0)
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--window-sec", type=float, default=DEFAULT_WINDOW_SEC)
    p.add_argument("--resp-window-sec", type=float, default=DEFAULT_RESP_WINDOW_SEC)
    p.add_argument("--min-sec", type=float, default=DEFAULT_MIN_SEC)
    p.add_argument("--resp-min-sec", type=float, default=DEFAULT_RESP_MIN_SEC)
    p.add_argument("--update-sec", type=float, default=DEFAULT_UPDATE_SEC)
    p.add_argument("--fs", type=float, default=DEFAULT_FS_RESAMPLE)
    p.add_argument("--resp-fs", type=float, default=DEFAULT_RESP_FS_RESAMPLE)
    p.add_argument("--bpm-min", type=float, default=DEFAULT_BPM_MIN)
    p.add_argument("--bpm-max", type=float, default=DEFAULT_BPM_MAX)
    p.add_argument("--rpm-min", type=float, default=DEFAULT_RPM_MIN)
    p.add_argument("--rpm-max", type=float, default=DEFAULT_RPM_MAX)
    p.add_argument("--heart-sqi-gate", type=float, default=DEFAULT_HEART_SQI_GATE, help="HR 표시/갱신 최소 SQI")
    p.add_argument("--resp-sqi-gate", type=float, default=DEFAULT_RESP_SQI_GATE)
    p.add_argument("--sqi-hysteresis", type=float, default=DEFAULT_SQI_HYSTERESIS,
                   help="신뢰가능/사용가능/보류 배지 전환 dead-band 폭(raw SQI/게이팅에는 영향 없음)")
    p.add_argument("--min-skin-pixels", type=int, default=DEFAULT_MIN_SKIN_PIXELS)
    p.add_argument("--jitter-scale-px", type=float, default=DEFAULT_JITTER_SCALE_PX)
    p.add_argument("--smooth-alpha", type=float, default=DEFAULT_SMOOTH_ALPHA)
    # 이번 확장 플래그
    p.add_argument("--lowfreq-ref", action="store_true", help="[3순위] 상체 호흡 신호로 rPPG 저주파 제거")
    p.add_argument("--use-facemesh", action="store_true", help="[2순위] MediaPipe 볼 다각형 ROI 사용(미설치 시 폴백)")
    p.add_argument("--scenario", type=str, default="", choices=["", "static", "lighting", "head_motion"],
                   help="[4순위] 실험 시나리오 태그(로그에 기록)")
 
    p.add_argument("--profile", action="store_true", help="[5순위] 종료 시 FPS/지연 요약 출력")
    p.add_argument("--duration", type=float, default=0.0,
                   help="지정 시 N초 후 자동 종료(0=무제한, q/ESC 종료만). run_experiment.py 자동화용")
    p.add_argument("--lock-exposure", action="store_true")
    p.add_argument("--force-lock-exposure", action="store_true")
    p.add_argument("--bright", type=float, default=1.0)
    p.add_argument("--low-bpm", type=float, default=50.0)
    p.add_argument("--high-bpm", type=float, default=120.0)
    p.add_argument("--low-rpm", type=float, default=8.0)
    p.add_argument("--high-rpm", type=float, default=24.0)
    p.add_argument("--alert-sustain-sec", type=float, default=8.0)
    p.add_argument("--alert-cooldown-sec", type=float, default=DEFAULT_ALERT_COOLDOWN_SEC)
    p.add_argument("--log", type=str, default="")
    p.add_argument("--alert-log", type=str, default="guardian_alerts.csv")
    p.add_argument("--alert-inbox", type=str, default="caregiver_inbox_demo.txt")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if args.selftest:
        return 0 if selftest() else 1
    run_webcam(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
