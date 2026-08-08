"""BH1750 조도 어댑터 (I2C).

L1 조명 개입이 이 값을 보고 판단한다. 조도가 틀리면 밤중에 불을 켜거나
밝은 방에서 또 켜는 일이 생기므로, 현장에서 조도계와 한 번 맞춰 볼 것.

드라이버 import 는 start() 안에서 한다. 이유는 env_bme680 참고.
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

from api.schemas import Metric, Mode, server_now
from core.adapters.base import SensorAdapter

log = structlog.get_logger(__name__)

_CONTINUOUS_HIGH_RES = 0x10  # 1lx 해상도, 120ms 주기
_RAW_TO_LUX = 1.2  # 데이터시트 계수


class Bh1750Adapter(SensorAdapter):
    provides = ["lux"]

    def __init__(self, id: str, mode: Mode, *, i2c_addr: int = 0x23, bus: int = 1) -> None:
        super().__init__(id, mode)
        self.i2c_addr = i2c_addr
        self.bus_number = bus
        self._bus: Any = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._bus = await loop.run_in_executor(None, self._open)

    async def stop(self) -> None:
        bus, self._bus = self._bus, None
        if bus is not None:
            bus.close()

    async def read(self) -> list[Metric]:
        loop = asyncio.get_running_loop()
        lux = await loop.run_in_executor(None, self._sample)
        return [
            Metric(
                key="lux", value=round(lux, 1), unit="lx", source=self.id,
                mode=self.mode, state="ok", confidence=None, ts=server_now(),
            )
        ]

    # --- 하드웨어 경계 ----------------------------------------------------- #

    def _open(self) -> Any:
        from smbus2 import SMBus  # 파이에서만 설치된다

        bus = SMBus(self.bus_number)
        bus.write_byte(self.i2c_addr, _CONTINUOUS_HIGH_RES)
        log.info("bh1750.opened", adapter=self.id, addr=hex(self.i2c_addr))
        return bus

    def _sample(self) -> float:
        if self._bus is None:
            raise RuntimeError("I2C 버스가 열려 있지 않다")
        raw = self._bus.read_i2c_block_data(self.i2c_addr, _CONTINUOUS_HIGH_RES, 2)
        return float(((raw[0] << 8) | raw[1]) / _RAW_TO_LUX)
