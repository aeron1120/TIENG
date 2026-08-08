"""환경 센서 합성 어댑터 (mock).

하드웨어가 오기 전에 L1 조명 개입을 실제로 돌려 보려고 만들었다. 조도를 주기적으로
어둡게 떨어뜨려 정책이 발화하는 조건을 만든다.

액추에이터가 불을 켜면 조도가 회복돼야 개입 전후 비교가 의미를 갖는다. 그래서
core.sim_room 에서 조명 상태를 읽어 lux 에 더하고, 계산한 조도를 다시 거기에
기록한다. hr_mock 이 그 조도로 신뢰도를 만든다. 실제 방에서는 조도계와 카메라가
같은 일을 물리적으로 하므로 이 배선은 mock 안에만 있다.
"""

from __future__ import annotations

import math
import random

from api.schemas import Metric, Mode, server_now
from core import sim_room
from core.adapters.base import SensorAdapter


class EnvMock(SensorAdapter):
    provides = ["temp", "humidity", "lux", "occupancy"]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        base_temp: float = 23.5,
        base_humidity: float = 45.0,
        base_lux: float = 140.0,
        dark_lux: float = 25.0,
        dark_every_s: int = 90,
        dark_for_s: int = 40,
    ) -> None:
        super().__init__(id, mode)
        self.base_temp = base_temp
        self.base_humidity = base_humidity
        self.base_lux = base_lux
        self.dark_lux = dark_lux
        self.dark_every_s = dark_every_s
        self.dark_for_s = dark_for_s
        self._tick = 0

    async def start(self) -> None:
        self._tick = 0

    async def stop(self) -> None:
        pass

    async def read(self) -> list[Metric]:
        self._tick += 1
        ts = server_now()

        # 주기적으로 방을 어둡게 만들어 L1 발화 조건을 만든다. 어두운 구간을 주기
        # 뒷부분에 두어 밝은 상태로 시작한다. 켜자마자 개입이 터지면 데모에서
        # "정상 → 악화 → 개입" 순서를 보여줄 수 없다.
        phase = self._tick % self.dark_every_s if self.dark_every_s else 0
        dark = self.dark_every_s > 0 and phase >= (self.dark_every_s - self.dark_for_s)
        lux = (self.dark_lux if dark else self.base_lux) + random.gauss(0, 2.0)
        lux = max(0.0, lux + sim_room.light_bonus_lux())
        sim_room.set_lux(lux)  # hr_mock 이 이 조도로 신뢰도를 만든다

        temp = self.base_temp + 0.6 * math.sin(self._tick / 90.0) + random.gauss(0, 0.05)
        humidity = self.base_humidity + 2.0 * math.sin(self._tick / 130.0) + random.gauss(0, 0.2)

        def metric(key: str, value: float, unit: str | None) -> Metric:
            return Metric(
                key=key, value=value, unit=unit, source=self.id,
                mode=self.mode, state="ok", confidence=None, ts=ts,
            )

        return [
            metric("temp", round(temp, 1), "°C"),
            metric("humidity", round(humidity, 1), "%"),
            metric("lux", round(lux, 1), "lx"),
            metric("occupancy", 1.0, None),
        ]
