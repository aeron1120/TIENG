"""thresholds.yaml 로더.

정책 조건은 코드가 아니라 여기서 온다. 시연 중에 민감도를 바꾸려면 코드를
고치는 게 아니라 프로파일을 바꿔야 한다 (README §0-5, §10).

발표할 때 어느 프로파일인지 밝혀야 하므로 profile 이름을 그대로 들고 다닌다.
"""

from __future__ import annotations

from datetime import datetime, time
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

DEFAULT_PATH = Path("config/thresholds.yaml")


class HrBand(BaseModel):
    low: float
    high: float
    sustain_s: int


class NightMode(BaseModel):
    start: str  # "22:00"
    end: str  # "07:00"

    def covers(self, at: datetime) -> bool:
        """야간 구간인지. 자정을 넘어가는 구간을 다룬다.

        ts 는 UTC 라서 로컬 시간으로 바꿔 판단한다. 사람이 자는 시각은 벽시계
        기준이지 UTC 기준이 아니다.
        """
        now = at.astimezone().time()
        start, end = _parse(self.start), _parse(self.end)
        if start <= end:
            return start <= now < end
        return now >= start or now < end


class Thresholds(BaseModel):
    profile: str
    hr: HrBand
    confidence_min: float = Field(ge=0.0, le=1.0)
    night_mode: NightMode
    policies: dict[str, dict[str, Any]] = Field(default_factory=dict)

    def policy(self, name: str) -> dict[str, Any]:
        """정책별 임계값. 없으면 빈 dict — 정책이 자기 기본값을 쓰게 둔다."""
        return self.policies.get(name, {})


def load(path: Path = DEFAULT_PATH) -> Thresholds:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    name = raw["profile"]
    if name not in raw:
        raise KeyError(f"thresholds.yaml 에 '{name}' 프로파일이 없다")
    return Thresholds(profile=name, **raw[name])


def _parse(hhmm: str) -> time:
    hour, minute = hhmm.split(":")
    return time(int(hour), int(minute))
