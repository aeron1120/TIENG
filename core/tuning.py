"""카메라마다 다른 졸음 튜닝값.

지표를 뽑는 구조는 그대로 두고 **숫자만** 카메라별로 가른다. 이 세션에서 맞춘
값들이 전부 이 노트북 내장 카메라(30fps, Intel MIPI) 전용이라는 게 이유다 —
음성 대조로 얻은 표준편차도, 눈 상자 비율도, 깜빡임 임계도 렌즈와 프레임률이
바뀌면 다시 재야 한다.

정책이 config/thresholds.yaml 로 빠져 있는 것과 같은 자리다 (README §0-5). 코드에
박아 두면 카메라를 바꿀 때마다 소스를 고치게 되고, 어느 값으로 측정한 결과인지도
남지 않는다.

    tuning/web_cam.yaml           노트북 내장 웹캠 — 이 세션에서 실측
    tuning/phone_cam.yaml         폰 카메라 — 미측정
    tuning/rasp_cam.yaml          Pi 카메라 모듈 — 미측정
    tuning/phone_smartglass.yaml  폰을 안경 위치에 둔 것 — 검출 경로가 다르다

**미측정 프로파일은 web_cam 값을 베껴 둔 출발점일 뿐이다.** 그 카메라로 음성
대조를 돌리기 전에는 그 숫자를 근거로 쓰면 안 된다.
"""

from __future__ import annotations

from pathlib import Path

import structlog
import yaml
from pydantic import BaseModel, Field

log = structlog.get_logger(__name__)

DEFAULT_PATH = Path("tuning/web_cam.yaml")


class Geometry(BaseModel):
    """눈 상자와 얼굴 검출. 렌즈 화각과 촬영 거리가 바뀌면 여기가 바뀐다."""

    # 두 눈 사이 거리(IOD)에 대한 비율. 픽셀로 고정하면 거리에 따라 깨진다.
    eye_box_w: float = 0.45
    eye_box_h: float = 0.32
    # 이보다 얼굴이 작으면 눈꺼풀을 가를 해상도가 안 나온다. 억지로 재느니 버린다.
    min_iod_px: float = 40.0
    yunet_score: float = 0.6
    yunet_nms: float = 0.3


class Openness(BaseModel):
    """개안도를 뜬 상태와 감은 상태 사이로 정규화하는 방식.

    분위수를 쓰는 이유는 한 번의 잡음 튐이 기준을 영구히 망치기 때문이다.
    """

    open_pctl: float = 90.0
    closed_pctl: float = 2.0
    min_samples: int = 60
    # 뜬 상태와 감은 상태가 이만큼은 벌어져야 믿는다. 한 번도 안 감으면 둘이 붙는데,
    # 그때 정규화하면 미세한 잡음이 곧바로 '감김'으로 증폭된다.
    min_span: float = 0.10


class Blink(BaseModel):
    """깜빡임을 잘라 내는 임계. 개안도 측정 품질과 프레임률에 함께 좌우된다."""

    enter: float = 0.55
    exit: float = 0.35
    min_s: float = 0.05
    max_s: float = 1.20


class Weights(BaseModel):
    """채널 가중. 합이 1 이 아니어도 되지만, 그러면 점수가 100 을 못 채운다.

    문헌의 정성적 순위를 옮긴 값이고 데이터로 맞춘 적이 없다. 카메라가 바뀌면
    어느 채널이 믿을 만한지도 바뀌므로 여기 둔다 — 안경 근접 카메라에는 얼굴이
    없어 head 가 0 이 되는 식이다.
    """

    reopen: float = 0.35
    duration: float = 0.25
    blink_rate: float = 0.15
    head: float = 0.15
    perclos: float = 0.10


class Score(BaseModel):
    """점수와 판정. 잡음 수준에 직접 좌우되므로 카메라별로 다시 잡아야 한다."""

    z_full: float = 3.0  # 기준선 표준편차의 이 배수면 그 채널이 만점
    z_sd_floor_rel: float = 0.10  # "평소의 10% 가 1σ" 보다 민감해지지 않게
    warn: float = 30.0
    alert: float = 60.0
    weights: Weights = Field(default_factory=Weights)


class Track(BaseModel):
    """눈을 실제로 본 비율의 문턱. 진입/이탈을 벌려 화면이 깜빡이지 않게 한다."""

    min_rate: float = 0.45
    keep_rate: float = 0.30


class Tuning(BaseModel):
    name: str = "unnamed"
    # 이 프로파일이 실측으로 맞춰진 것인가. False 면 화면과 로그가 그렇게 말한다.
    measured: bool = False
    notes: str = ""
    window_s: float = 60.0
    baseline_s: float = 90.0
    geometry: Geometry = Field(default_factory=Geometry)
    openness: Openness = Field(default_factory=Openness)
    blink: Blink = Field(default_factory=Blink)
    score: Score = Field(default_factory=Score)
    track: Track = Field(default_factory=Track)


def load(path: Path | None = None) -> Tuning:
    """튜닝 프로파일. 못 읽으면 기본값으로 돌아간다.

    파일 하나 때문에 어댑터가 안 뜨면 곤란하다. 대신 무엇을 못 읽었는지는 남긴다.
    """
    target = path or DEFAULT_PATH
    try:
        raw = yaml.safe_load(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        log.warning("tuning.missing", path=str(target))
        return Tuning()
    except (OSError, ValueError) as exc:
        log.warning("tuning.load_failed", path=str(target), error=str(exc))
        return Tuning()
    return Tuning.model_validate(raw or {})
