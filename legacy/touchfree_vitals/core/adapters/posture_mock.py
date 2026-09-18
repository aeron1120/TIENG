"""자세·낙상 합성 어댑터 (mock).

value가 float이 아니라 문자열인 유일한 지표라, 프론트가 str 값을 제대로 렌더하는지
Phase 1에서 미리 확인하는 역할도 겸한다.
"""

from api.schemas import Metric, Mode, server_now
from core.adapters.base import SensorAdapter

_CYCLE = ["sitting", "sitting", "standing", "lying", "lying", "sitting"]


class PostureMock(SensorAdapter):
    provides = ["posture"]

    def __init__(self, id: str, mode: Mode, *, hold_ticks: int = 4) -> None:
        super().__init__(id, mode)
        self.hold_ticks = hold_ticks
        self._tick = 0

    async def start(self) -> None:
        self._tick = 0

    async def read(self) -> list[Metric]:
        self._tick += 1
        pose = _CYCLE[(self._tick // self.hold_ticks) % len(_CYCLE)]
        return [
            Metric(
                key="posture",
                value=pose,
                unit=None,
                source=self.id,
                mode=self.mode,
                state="ok",
                confidence=0.7,
                ts=server_now(),
            )
        ]

    async def stop(self) -> None:
        pass
