"""테스트가 module 경로로 지목하는 어댑터. registry의 동적 로드 경로를 그대로 태운다."""

from api.schemas import Metric
from core.adapters.base import SensorAdapter


class BoomAdapter(SensorAdapter):
    provides = ["hr"]

    async def start(self) -> None:
        pass

    async def read(self) -> list[Metric]:
        raise RuntimeError("센서 연결 끊김")

    async def stop(self) -> None:
        pass
