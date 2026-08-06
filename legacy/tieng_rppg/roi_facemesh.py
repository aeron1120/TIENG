"""
roi_facemesh.py  -  MediaPipe Face Mesh 볼(Cheek) 다각형 ROI (선택 모듈)
========================================================================
논문 2.1.2 / Figure 2-3 의 "얼굴 랜드마크 기반 좌/우 볼 다각형 ROI + YCrCb 스킨 마스크"
구조를 rppg_demo_v4.py 의 사각형 Haar ROI 대안으로 제공한다.

설계 원칙
- MediaPipe/cv2 가 없거나 얼굴이 안 잡히면 예외 없이 폴백(호출측이 Haar 경로로 복귀).
- rppg_demo_v4.RoiSample 과 동일한 필드를 갖는 MeshRoiSample 을 반환(덕타이핑).
- 다각형 → 마스크 → 스킨 마스크 교집합 → 피부 픽셀 평균 RGB. 이 핵심 기하는
  cv2만으로 단위 테스트 가능(polygon_roi_rgb).

주의: 볼 랜드마크 인덱스는 데모 튜닝용 근사값이다. 실제 배포 시 Figure 2-3 기준으로
      피험자/해상도에 맞춰 조정하라(=== TUNABLE ===).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np

# MediaPipe FaceMesh(468) 볼 다각형 근사 인덱스 (=== TUNABLE ===)
# 눈/입/코를 피하고 광대~볼 중앙의 피부면을 감싸도록 선택.
LEFT_CHEEK_IDX = [50, 205, 206, 203, 129, 209, 126, 117, 118, 101]
RIGHT_CHEEK_IDX = [280, 425, 426, 423, 358, 429, 355, 346, 347, 330]

_DEFAULT_MIN_SKIN = 150


@dataclass
class MeshRoiSample:
    """rppg_demo_v4.RoiSample 호환 (덕타이핑). polygons 는 시각화용 추가 필드."""

    rgb: Optional[Tuple[float, float, float]]
    skin_pixel_count: int
    skin_ratio: float
    brightness: float
    roi_name: str
    center: Optional[Tuple[float, float]]
    boxes: List[Tuple[str, Tuple[int, int, int, int], bool]] = field(default_factory=list)
    polygons: List[Tuple[str, np.ndarray, bool]] = field(default_factory=list)


def is_available() -> bool:
    """mediapipe 와 cv2 를 모두 import 할 수 있으면 True."""
    try:
        import cv2  # noqa: F401
        import mediapipe  # noqa: F401
        return True
    except Exception:
        return False


def _skin_mask_ycrcb_cv2(bgr_roi: np.ndarray) -> np.ndarray:
    """cv2 기반 YCrCb 스킨 마스크(0/1). 데모 스킨마스크와 동일 임계값."""
    import cv2

    ycrcb = cv2.cvtColor(bgr_roi, cv2.COLOR_BGR2YCrCb)
    y, cr, cb = ycrcb[:, :, 0], ycrcb[:, :, 1], ycrcb[:, :, 2]
    mask = (
        (cr >= 133) & (cr <= 173)
        & (cb >= 77) & (cb <= 127)
        & (y >= 40) & (y <= 250)
    )
    return mask.astype(np.uint8)


def polygon_roi_rgb(
    frame_bgr: np.ndarray,
    polygon: np.ndarray,
    *,
    min_skin: int = _DEFAULT_MIN_SKIN,
) -> Tuple[Optional[Tuple[float, float, float]], int, float, float, Tuple[int, int, int, int]]:
    """
    다각형 내부의 피부 픽셀만으로 평균 RGB 계산 (cv2 필요).

    반환: (rgb 또는 None, skin_pixel_count, skin_ratio, brightness, bbox(x,y,w,h))
    - skin_ratio = 스킨 픽셀 / 다각형 내부 픽셀
    - 피부 픽셀 < min_skin 이면 rgb=None
    """
    import cv2

    h, w = frame_bgr.shape[:2]
    poly = np.asarray(polygon, dtype=np.int32).reshape(-1, 2)
    poly[:, 0] = np.clip(poly[:, 0], 0, w - 1)
    poly[:, 1] = np.clip(poly[:, 1], 0, h - 1)
    x, y, bw, bh = cv2.boundingRect(poly)
    bw = max(bw, 1)
    bh = max(bh, 1)

    sub = frame_bgr[y : y + bh, x : x + bw]
    if sub.size == 0:
        return None, 0, 0.0, 0.0, (x, y, bw, bh)

    local_poly = poly - np.array([x, y])
    poly_mask = np.zeros((bh, bw), dtype=np.uint8)
    cv2.fillPoly(poly_mask, [local_poly], 1)
    inside = int(poly_mask.sum())
    if inside == 0:
        return None, 0, 0.0, 0.0, (x, y, bw, bh)

    skin = _skin_mask_ycrcb_cv2(sub) & poly_mask
    count = int(skin.sum())
    skin_ratio = count / inside

    if count < min_skin:
        return None, count, skin_ratio, 0.0, (x, y, bw, bh)

    sel = skin.astype(bool)
    b = float(sub[:, :, 0][sel].mean())
    g = float(sub[:, :, 1][sel].mean())
    r = float(sub[:, :, 2][sel].mean())
    brightness = (r + g + b) / 3.0
    return (r, g, b), count, skin_ratio, brightness, (x, y, bw, bh)


def _combine(valid: List[dict]) -> MeshRoiSample:
    weights = np.array([v["count"] for v in valid], dtype=np.float64)
    rgb_stack = np.stack([np.array(v["rgb"]) for v in valid], axis=0)
    combined = np.average(rgb_stack, axis=0, weights=weights)
    dominant = max(valid, key=lambda v: v["count"])
    total_skin = int(sum(v["count"] for v in valid))
    roi_name = dominant["name"] if len(valid) == 1 else "mesh_multi"
    boxes = [(v["name"], v["bbox"], True) for v in valid]
    polys = [(v["name"], v["poly"], True) for v in valid]
    return MeshRoiSample(
        rgb=(float(combined[0]), float(combined[1]), float(combined[2])),
        skin_pixel_count=total_skin,
        skin_ratio=float(dominant["ratio"]),
        brightness=float(dominant["brightness"]),
        roi_name=roi_name,
        center=dominant["center"],
        boxes=boxes,
        polygons=polys,
    )


class FaceMeshCheekROI:
    """MediaPipe Face Mesh 로 좌/우 볼 다각형을 뽑아 피부 RGB 를 샘플링."""

    def __init__(self, min_skin: int = _DEFAULT_MIN_SKIN) -> None:
        import mediapipe as mp  # 실패 시 호출측이 폴백

        self.min_skin = min_skin
        self._mp = mp
        self._mesh = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=False,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

    def close(self) -> None:
        try:
            self._mesh.close()
        except Exception:
            pass

    def _landmarks_to_polygon(self, landmarks, idx_list, w: int, h: int) -> np.ndarray:
        pts = []
        for i in idx_list:
            lm = landmarks[i]
            pts.append([int(lm.x * w), int(lm.y * h)])
        return np.array(pts, dtype=np.int32)

    def sample(self, frame_bgr: np.ndarray) -> MeshRoiSample:
        """한 프레임에서 볼 ROI 샘플. 얼굴 없으면 rgb=None, roi_name='none'."""
        import cv2

        h, w = frame_bgr.shape[:2]
        rgb_frame = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        results = self._mesh.process(rgb_frame)
        if not results.multi_face_landmarks:
            return MeshRoiSample(None, 0, 0.0, 0.0, "none", None, [], [])

        landmarks = results.multi_face_landmarks[0].landmark
        valid: List[dict] = []
        for name, idx in (("left_cheek", LEFT_CHEEK_IDX), ("right_cheek", RIGHT_CHEEK_IDX)):
            poly = self._landmarks_to_polygon(landmarks, idx, w, h)
            rgb, count, ratio, bright, bbox = polygon_roi_rgb(frame_bgr, poly, min_skin=self.min_skin)
            if rgb is not None:
                cx = float(poly[:, 0].mean())
                cy = float(poly[:, 1].mean())
                valid.append({
                    "name": name, "rgb": rgb, "count": count, "ratio": ratio,
                    "brightness": bright, "center": (cx, cy), "bbox": bbox, "poly": poly,
                })

        if not valid:
            return MeshRoiSample(None, 0, 0.0, 0.0, "none", None, [], [])
        return _combine(valid)


# --------------------------------------------------------------------------- #
# Selftest (cv2 필요, mediapipe 불필요)
# --------------------------------------------------------------------------- #
def selftest() -> bool:
    print("=== roi_facemesh.py SELFTEST (polygon geometry) ===")
    try:
        import cv2  # noqa: F401
    except Exception:
        print("  SKIP: cv2 미설치 (pip install opencv-python-headless)")
        return True

    # 피부톤 사각형 위에 다각형을 얹어 RGB/스킨 추출이 되는지
    frame = np.zeros((200, 200, 3), dtype=np.uint8)
    frame[:] = (40, 40, 40)
    frame[40:160, 40:160] = (120, 150, 200)  # BGR 피부톤 블록
    poly = np.array([[60, 60], [140, 60], [140, 140], [60, 140]], dtype=np.int32)
    rgb, count, ratio, bright, bbox = polygon_roi_rgb(frame, poly, min_skin=150)
    c1 = rgb is not None and count > 1000 and ratio > 0.9
    # RGB 정확도: (r,g,b)=(200,150,120)
    c2 = rgb is not None and abs(rgb[0] - 200) < 2 and abs(rgb[2] - 120) < 2
    print(f"  {'OK' if c1 else 'XX'} skin polygon: count={count} ratio={ratio:.2f} bbox={bbox}")
    print(f"  {'OK' if c2 else 'XX'} mean RGB={None if rgb is None else [round(x,1) for x in rgb]}")

    # 비피부 다각형은 배제
    poly2 = np.array([[5, 5], [30, 5], [30, 30], [5, 30]], dtype=np.int32)  # 회색 배경
    rgb2, count2, ratio2, _, _ = polygon_roi_rgb(frame, poly2, min_skin=150)
    c3 = rgb2 is None
    print(f"  {'OK' if c3 else 'XX'} non-skin polygon rejected (count={count2})")

    # 다각형 결합(_combine) 가중 평균
    valid = [
        {"name": "left_cheek", "rgb": (200, 150, 120), "count": 3000, "ratio": 0.95,
         "brightness": 156.7, "center": (100, 100), "bbox": (60, 60, 80, 80),
         "poly": poly},
        {"name": "right_cheek", "rgb": (100, 100, 100), "count": 1000, "ratio": 0.5,
         "brightness": 100.0, "center": (150, 100), "bbox": (140, 60, 40, 80),
         "poly": poly},
    ]
    s = _combine(valid)
    exp_r = (200 * 3000 + 100 * 1000) / 4000
    c4 = s.roi_name == "mesh_multi" and abs(s.rgb[0] - exp_r) < 1e-6 and s.skin_pixel_count == 4000
    print(f"  {'OK' if c4 else 'XX'} weighted combine: name={s.roi_name} r={s.rgb[0]:.1f} (exp {exp_r:.1f})")

    print(f"  mediapipe available: {is_available()}")
    ok = all([c1, c2, c3, c4])
    print(f"=== RESULT: {'PASS' if ok else 'FAIL'} ===")
    return ok


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
