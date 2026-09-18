"""호흡수 합성 어댑터 (하드웨어 없이 파이프라인을 돌리기 위한 mock).

값은 정현파 + 가우시안 잡음이며 실측이 아니다. config에서 mode를 절대 live로 주지 말 것.
주기적으로 low_quality 구간을 만드는 이유: "값을 지어내지 않는다"(README §0-4) 경로를
데모에서 실제로 눈에 보이게 태우기 위해서다.
"""

import math
import random

from api.schemas import Metric, Mode, State, server_now
from core.adapters.base import SensorAdapter


class RespirationMock(SensorAdapter):
    provides = ["rr"]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        base_rpm: float = 15.0,
        noise: float = 1.2,
        low_quality_every: int = 7,
    ) -> None:
        super().__init__(id, mode)
        self.base_rpm = base_rpm
        self.noise = noise
        self.low_quality_every = low_quality_every
        self._tick = 0

    async def start(self) -> None:
        self._tick = 0

    async def read(self) -> list[Metric]:
        self._tick += 1
        if self.low_quality_every and self._tick % self.low_quality_every == 0:
            return [self._metric(None, 0.21, "low_quality")]
        rpm = self.base_rpm + 2.0 * math.sin(self._tick / 12.0) + random.gauss(0.0, self.noise)
        return [self._metric(round(rpm, 1), 0.83, "ok")]

    async def stop(self) -> None:
        pass

    def _metric(self, value: float | None, confidence: float, state: State) -> Metric:
        return Metric(
            key="rr",
            value=value,
            unit="rpm",
            source=self.id,
            mode=self.mode,
            state=state,
            confidence=confidence,
            ts=server_now(),
        )
