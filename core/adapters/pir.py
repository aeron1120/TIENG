"""PIR 재실 감지 어댑터 (GPIO).

PIR 은 "움직임"이 있을 때만 순간적으로 뛴다. 그대로 내보내면 가만히 앉아 있는
사람이 1초마다 사라졌다 나타난다. hold_s 동안 감지 상태를 유지해 사람이
머무르는 구간으로 바꾼다.

드라이버 import 는 start() 안에서 한다. 이유는 env_bme680 참고.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import structlog

from api.schemas import Metric, Mode, server_now
from core.adapters.base import SensorAdapter

log = structlog.get_logger(__name__)


class PirAdapter(SensorAdapter):
    provides = ["occupancy"]

    def __init__(self, id: str, mode: Mode, *, pin: int = 4, hold_s: float = 30.0) -> None:
        super().__init__(id, mode)
        self.pin = pin
        self.hold_s = hold_s
        self._sensor: Any = None
        self._last_motion: float | None = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._sensor = await loop.run_in_executor(None, self._open)
        self._last_motion = None

    async def stop(self) -> None:
        sensor, self._sensor = self._sensor, None
        if sensor is not None:
            sensor.close()

    async def read(self) -> list[Metric]:
        if self._sensor is None:
            raise RuntimeError("PIR 이 열려 있지 않다")

        now = time.monotonic()
        if bool(self._sensor.motion_detected):
            self._last_motion = now

        held = self._last_motion is not None and (now - self._last_motion) <= self.hold_s
        return [
            Metric(
                key="occupancy", value=1.0 if held else 0.0, unit=None, source=self.id,
                mode=self.mode, state="ok", confidence=None, ts=server_now(),
            )
        ]

    # --- 하드웨어 경계 ----------------------------------------------------- #

    def _open(self) -> Any:
        from gpiozero import MotionSensor  # 파이에서만 설치된다

        sensor = MotionSensor(self.pin)
        log.info("pir.opened", adapter=self.id, pin=self.pin, hold_s=self.hold_s)
        return sensor
