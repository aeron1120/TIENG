"""눈 크롭 한 장에서 동공을 재는 부분.

안경 근접 카메라로 옮겨도 그대로 쓰는 코드는 여기뿐이다. 웹캠 단계에서는
FaceMesh 가 얼굴에서 눈을 잘라 주지만(run_plr.py), 안경에서는 눈이 곧 화면
전체라 그 단계가 통째로 사라진다. 그래서 입력을 "눈 크롭 + 홍채 원"으로 좁혀
둔다 — 이 함수는 얼굴이 있었다는 사실조차 모른다.

동공을 '검출하는 것'과 '잴 수 있는지 판단하는 것'은 다른 일이다. 여기서는 둘
다 한다. 타원을 맞추고, 그 타원을 믿어도 되는지를 대비(d')로 같이 내보낸다.
가시광에서 짙은 갈색 홍채는 동공과 밝기가 거의 같아서 **타원은 언제나 나오지만
그 타원이 아무 의미도 없는** 경우가 생긴다. 숫자가 없으면 그 둘을 구분할 수
없고, "웹캠으로는 안 되더라"와 "우리 검출이 나빴다"를 영영 못 가른다.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# 홍채 경계(윤부)는 눈꺼풀·속눈썹과 붙어 있어 지저분하다. 살짝 안쪽만 본다.
IRIS_SHRINK = 0.92

# 동공/홍채 반지름 비의 생리적 범위. 사람의 동공은 대략 2~8mm, 홍채는 약 11.7mm 라
# 0.17~0.70 이 실제 범위다. 여유를 두되, 이 밖으로 나가면 잘못 잡은 것으로 본다.
RATIO_MIN = 0.15
RATIO_MAX = 0.80

# 반사광(각막에 비친 화면·조명). 동공 한가운데 밝은 점으로 앉아 어두운 덩어리를
# 둘로 쪼개므로 타원 피팅 전에 지워야 한다.
SPECULAR_PCTL = 97.0
SPECULAR_MIN = 180
SPECULAR_DILATE = 3


@dataclass
class PupilSample:
    """한 눈, 한 프레임의 측정치. 좌표는 전부 크롭 이미지 기준이다."""

    cx: float
    cy: float
    r_eq: float  # 등가 반지름 sqrt(장축*단축)/2
    axis_major: float
    axis_minor: float
    angle: float
    ratio: float  # r_eq / 홍채 반지름 — 미끄러짐·거리에 불변인 정규화 값
    dprime: float  # 홍채와 동공의 밝기 분리도. 이게 낮으면 위 값은 무의미하다
    mean_pupil: float
    mean_iris: float
    specular_frac: float  # 홍채 원 안에서 반사광이 먹은 비율
    confidence: float


def measure(gray: np.ndarray, cx: float, cy: float, r: float) -> PupilSample | None:
    """눈 크롭(그레이스케일)에서 동공 타원을 찾는다.

    cx, cy, r 은 같은 크롭 좌표계의 홍채 원이다. 못 찾으면 None — 값을 지어내지
    않는다. 판단 근거는 반환값의 dprime/confidence 에 실려 나간다.
    """
    h, w = gray.shape[:2]
    iris_mask = np.zeros((h, w), np.uint8)
    cv2.circle(iris_mask, (int(round(cx)), int(round(cy))), int(r * IRIS_SHRINK), 255, -1)
    if cv2.countNonZero(iris_mask) < 50:
        return None

    inside = gray[iris_mask > 0]
    if inside.size < 50:
        return None

    # --- 반사광 제거 --------------------------------------------------------- #
    # 임계를 고정값과 분위수 중 큰 쪽으로 잡는다. 어두운 방에서는 분위수만 쓰면
    # 반사광이 없는데도 상위 3%를 무조건 반사광으로 지워 버린다.
    spec_thr = max(SPECULAR_MIN, float(np.percentile(inside, SPECULAR_PCTL)))
    specular = ((gray >= spec_thr) & (iris_mask > 0)).astype(np.uint8) * 255
    if SPECULAR_DILATE > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (SPECULAR_DILATE, SPECULAR_DILATE))
        specular = cv2.dilate(specular, k)
    specular = cv2.bitwise_and(specular, iris_mask)
    specular_frac = float(cv2.countNonZero(specular)) / float(cv2.countNonZero(iris_mask))

    # 반사광이 홍채를 절반 넘게 먹으면 그 프레임은 볼 게 없다.
    if specular_frac > 0.5:
        return None
    work = cv2.inpaint(gray, specular, 3, cv2.INPAINT_TELEA) if specular_frac > 0 else gray

    # --- 동공 후보 ----------------------------------------------------------- #
    # Otsu 를 홍채 원 안쪽 픽셀에만 건다. 프레임 전체로 돌리면 눈꺼풀·피부·흰자가
    # 히스토그램을 지배해서 동공과 홍채를 가르는 임계가 나오지 않는다.
    vals = work[iris_mask > 0].reshape(-1, 1)
    thr, _ = cv2.threshold(vals, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = ((work <= thr) & (iris_mask > 0)).astype(np.uint8) * 255

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, k)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, k)

    blob = _pick_blob(dark, cx, cy, r)
    if blob is None:
        return None

    contours, _ = cv2.findContours(blob, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if len(contour) < 5:  # fitEllipse 의 최소 점 개수
        return None

    (ex, ey), (axis_a, axis_b), angle = cv2.fitEllipse(contour)
    major, minor = max(axis_a, axis_b), min(axis_a, axis_b)
    r_eq = float(np.sqrt(major * minor) / 2.0)
    ratio = r_eq / r
    if not (RATIO_MIN <= ratio <= RATIO_MAX):
        return None

    # --- 대비: 이 측정을 믿어도 되는가 --------------------------------------- #
    # 동공 안쪽과 홍채 고리를 각각 재서 분리도를 낸다. 경계선 픽셀은 양쪽이 섞이므로
    # 동공은 조금 안쪽만, 홍채는 조금 바깥만 본다.
    center = (int(round(ex)), int(round(ey)))
    pupil_mask = np.zeros((h, w), np.uint8)
    cv2.ellipse(pupil_mask, center, _axes(major, minor, 0.8), angle, 0, 360, 255, -1)
    pupil_mask = cv2.bitwise_and(pupil_mask, cv2.bitwise_not(specular))

    ring = np.zeros((h, w), np.uint8)
    cv2.ellipse(ring, center, _axes(major, minor, 1.25), angle, 0, 360, 255, -1)
    ring = cv2.bitwise_and(iris_mask, cv2.bitwise_not(ring))
    ring = cv2.bitwise_and(ring, cv2.bitwise_not(specular))

    p_px, i_px = gray[pupil_mask > 0], gray[ring > 0]
    if p_px.size < 20 or i_px.size < 20:
        return None

    mean_p, mean_i = float(p_px.mean()), float(i_px.mean())
    pooled = np.sqrt((p_px.var() + i_px.var()) / 2.0)
    dprime = float((mean_i - mean_p) / pooled) if pooled > 1e-6 else 0.0

    return PupilSample(
        cx=float(ex),
        cy=float(ey),
        r_eq=r_eq,
        axis_major=float(major),
        axis_minor=float(minor),
        angle=float(angle),
        ratio=float(ratio),
        dprime=dprime,
        mean_pupil=mean_p,
        mean_iris=mean_i,
        specular_frac=specular_frac,
        confidence=_confidence(dprime, minor / major, specular_frac),
    )


def _axes(major: float, minor: float, k: float) -> tuple[int, int]:
    """cv2.ellipse 는 정수 반축을 받는다. 1px 미만으로 찌그러지면 마스크가 비어 버린다."""
    return max(int(round(major / 2 * k)), 1), max(int(round(minor / 2 * k)), 1)


def _pick_blob(dark: np.ndarray, cx: float, cy: float, r: float) -> np.ndarray | None:
    """동공일 법한 덩어리 하나. 홍채 중심에 가깝고 크기가 그럴듯한 것을 고른다.

    가장 큰 덩어리를 고르지 않는 이유는, 속눈썹 그림자가 홍채 위쪽을 가로질러
    동공보다 넓은 어두운 띠를 만드는 일이 흔하기 때문이다.
    """
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(dark, connectivity=8)
    iris_area = np.pi * r * r

    best, best_d = None, None
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        frac = area / iris_area
        if not (RATIO_MIN**2 <= frac <= RATIO_MAX**2):
            continue
        d = float(np.hypot(centroids[i][0] - cx, centroids[i][1] - cy))
        if d > r * 0.6:  # 동공 중심이 홍채 중심에서 이만큼 벗어날 수는 없다
            continue
        if best_d is None or d < best_d:
            best, best_d = i, d

    if best is None:
        return None
    return (labels == best).astype(np.uint8) * 255


def _confidence(dprime: float, axis_ratio: float, specular_frac: float) -> float:
    """0~1. 세 근거의 곱 — 하나만 나빠도 전체가 내려간다.

    d' 를 3.0 에서 포화시킨다. 통계적으로 두 분포가 거의 겹치지 않는 지점이고,
    그 위로 더 좋아져도 '잴 수 있다'는 판단은 달라지지 않는다.
    """
    sep = min(max(dprime, 0.0) / 3.0, 1.0)
    # 정면을 보면 동공은 원이다. 시선이 돌아가면 타원이 되므로 완만하게만 깎는다.
    shape = min(max(axis_ratio - 0.3, 0.0) / 0.5, 1.0)
    clean = 1.0 - min(specular_frac / 0.3, 1.0)
    return float(sep * shape * clean)


def draw(bgr: np.ndarray, cx: float, cy: float, r: float, s: PupilSample | None) -> np.ndarray:
    """미리보기용 오버레이. 홍채는 청록, 동공은 호박색."""
    out = bgr.copy()
    cv2.circle(out, (int(round(cx)), int(round(cy))), int(round(r)), (190, 178, 87), 1)
    if s is not None:
        cv2.ellipse(
            out,
            ((s.cx, s.cy), (s.axis_major, s.axis_minor), s.angle),
            (69, 154, 226),
            1,
        )
        cv2.drawMarker(out, (int(s.cx), int(s.cy)), (69, 154, 226), cv2.MARKER_CROSS, 7, 1)
    return out
