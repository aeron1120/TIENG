"""Tuya 스마트 플러그/전구 (LAN 제어).

클라우드가 아니라 로컬 네트워크로 직접 명령한다. 인터넷이 끊겨도 개입이 동작해야
하고, 집 안 센서 값이 밖으로 나가서도 안 된다 (README §1).

mode 가 live 가 아니면 네트워크를 건드리지 않고 상태만 기록한다. 그 상태를
core.sim_room 에 반영해 mock 조도계가 "불이 켜졌다"를 볼 수 있게 한다.
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

from actuators.base import Actuator
from api.schemas import Mode
from core.sim_room import set_light

log = structlog.get_logger(__name__)


class TuyaPlug(Actuator):
    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        device_id: str = "",
        local_key: str = "",
        ip: str = "",
        version: float = 3.3,
        # simulated 모드에서 이 전구가 방에 더하는 조도. 실측에서는 조도계가 잰다.
        simulated_lux_gain: float = 120.0,
    ) -> None:
        super().__init__(id, mode)
        self.device_id = device_id
        self.local_key = local_key
        self.ip = ip
        self.version = version
        self.simulated_lux_gain = simulated_lux_gain
        self._device: Any = None
        self._on = False

    @property
    def is_on(self) -> bool:
        return self._on

    async def start(self) -> None:
        if self.mode != "live":
            log.info("tuya.simulated", actuator=self.id)
            return
        if not (self.device_id and self.local_key and self.ip):
            raise RuntimeError("device_id / local_key / ip 가 설정돼 있지 않다")
        loop = asyncio.get_running_loop()
        self._device = await loop.run_in_executor(None, self._connect)

    async def stop(self) -> None:
        # 되돌릴 수 있는 개입은 원상복구한다. 서버를 껐는데 불이 켜진 채로 남으면
        # 사용자가 시스템을 신뢰하지 않는다.
        if self._on:
            await self.turn_off()
        self._device = None

    async def turn_on(self) -> None:
        await self._set(True)

    async def turn_off(self) -> None:
        await self._set(False)

    # --- 하드웨어 경계 ----------------------------------------------------- #

    async def _set(self, on: bool) -> None:
        if self.mode == "live":
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._switch, on)
        else:
            set_light(on, self.simulated_lux_gain)
        self._on = on
        log.info("tuya.switch", actuator=self.id, on=on, mode=self.mode)

    def _connect(self) -> Any:
        import tinytuya  # 파이/실기에서만 설치된다

        device = tinytuya.OutletDevice(self.device_id, self.ip, self.local_key)
        device.set_version(self.version)
        status = device.status()
        if "Error" in status:
            raise RuntimeError(f"Tuya 연결 실패: {status}")
        log.info("tuya.connected", actuator=self.id, ip=self.ip)
        return device

    def _switch(self, on: bool) -> None:
        if self._device is None:
            raise RuntimeError("Tuya 장치에 연결돼 있지 않다")
        result = self._device.set_status(on, 1)
        if isinstance(result, dict) and "Error" in result:
            raise RuntimeError(f"Tuya 명령 실패: {result}")
