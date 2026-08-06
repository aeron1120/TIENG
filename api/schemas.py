"""2절 데이터 계약. 모든 계층(core / api / web)이 이 스키마 하나로만 통신한다.

여기를 고치면 전 계층이 따라 움직여야 하므로 임의 변경 금지 (README §0-1).
"""

from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

Mode = Literal["live", "simulated", "unavailable"]
State = Literal["ok", "low_quality", "stale", "error", "no_adapter"]

# 0.0~1.0 범위 밖 confidence는 게이팅 판단을 조용히 망가뜨리므로 스키마에서 막는다.
Confidence = Annotated[float, Field(ge=0.0, le=1.0)]


def server_now() -> datetime:
    """모든 ts의 단일 소스.

    어댑터가 각자 시계를 쓰면 개입 전후 비교가 무의미해진다 (README §2).
    """
    return datetime.now(UTC)


class Metric(BaseModel):
    key: str  # "hr" | "rr" | "temp" | "humidity" | "lux" | "noise" | "occupancy" | "posture"
    value: float | str | None
    unit: str | None
    source: str  # 어댑터 id, 예: "rppg", "bme680", "ld2410"
    mode: Mode
    state: State
    confidence: Confidence | None  # 해당 없으면 None
    ts: datetime  # 서버 단일 시계 기준


class InterventionEvent(BaseModel):
    id: str
    level: Literal["L0", "L1", "L2", "L3", "L4"]
    action: str  # "light_up" | "ventilate" | "breathing_guide" | "notify_guardian"
    trigger: str  # 사람이 읽을 수 있는 발화 조건 문자열
    before: dict[str, float]  # 개입 직전 지표 스냅샷
    after: dict[str, float] | None  # 개입 후 평가 윈도우 종료 시 채움
    accepted: bool | None  # 사용자 제안형 개입의 수용 여부
    ts: datetime


class Snapshot(BaseModel):
    device_id: str
    ts: datetime
    metrics: list[Metric]
    interventions: list[InterventionEvent]  # 최근 N건
