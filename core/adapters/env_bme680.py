"""BME680 온습도 어댑터 (I2C).

드라이버는 start() 안에서 늦게 import 한다. 모듈 자체는 어디서든 import 되어야
registry 가 provides 를 읽어 카드 자리를 잡을 수 있다. 개발 PC 에서는 start() 가
실패해 카드가 no_adapter 로 뜨고, 파이에 꽂으면 같은 자리에 값이 들어온다.

기압과 VOC 도 이 센서가 주지만 내보내지 않는다. 2절 계약의 metric key 목록에
없는 값이라, 추가하려면 계약부터 고쳐야 한다 (README §0-1).
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

from api.schemas import Metric, Mode, server_now
from core.adapters.base import SensorAdapter

log = structlog.get_logger(__name__)


class Bme680Adapter(SensorAdapter):
    provides = ["temp", "humidity"]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        i2c_addr: int = 0x76,
        temp_offset: float = 0.0,
    ) -> None:
        super().__init__(id, mode)
        self.i2c_addr = i2c_addr
        # 보드 자체 발열로 실제보다 높게 읽힌다. 현장에서 온도계와 맞춰 보정한다.
        self.temp_offset = temp_offset
        self._sensor: Any = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._sensor = await loop.run_in_executor(None, self._open)

    async def stop(self) -> None:
        self._sensor = None

    async def read(self) -> list[Metric]:
        loop = asyncio.get_running_loop()
        temp, humidity = await loop.run_in_executor(None, self._sample)
        ts = server_now()
        return [
            Metric(
                key="temp", value=round(temp, 1), unit="°C", source=self.id,
                mode=self.mode, state="ok", confidence=None, ts=ts,
            ),
            Metric(
                key="humidity", value=round(humidity, 1), unit="%", source=self.id,
                mode=self.mode, state="ok", confidence=None, ts=ts,
            ),
        ]

    # --- 하드웨어 경계 ----------------------------------------------------- #

    def _open(self) -> Any:
        import bme680  # 파이에서만 설치된다

        sensor = bme680.BME680(self.i2c_addr)
        sensor.set_humidity_oversample(bme680.OS_2X)
        sensor.set_temperature_oversample(bme680.OS_8X)
        sensor.set_filter(bme680.FILTER_SIZE_3)
        # 가스 히터는 쓰지 않는다. VOC 를 안 내보내는데 켜 두면 온도만 끌어올린다.
        sensor.set_gas_status(bme680.DISABLE_GAS_MEAS)
        log.info("bme680.opened", adapter=self.id, addr=hex(self.i2c_addr))
        return sensor

    def _sample(self) -> tuple[float, float]:
        if self._sensor is None:
            raise RuntimeError("센서가 열려 있지 않다")
        if not self._sensor.get_sensor_data():
            raise RuntimeError("BME680 이 새 측정값을 내놓지 않았다")
        data = self._sensor.data
        return float(data.temperature) + self.temp_offset, float(data.humidity)
