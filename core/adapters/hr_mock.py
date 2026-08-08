"""심박수 합성 어댑터 (mock).

rPPG 의 핵심 성질 하나를 흉내 낸다: **어두우면 신뢰도가 떨어진다.** 그래야
하드웨어 없이도 L1 조명 개입의 전 구간을 볼 수 있다.

    방이 어두워짐 → 신뢰도 하락 → 값 보류 → L1 발화 → 조명 ON
    → 조도 회복 → 신뢰도 회복 → 값 복귀

값은 실측이 아니다. config 에서 mode 를 live 로 주지 말 것.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from api.schemas import Metric, Mode, State, server_now
from core import sim_room, thresholds
from core.adapters.base import SensorAdapter


class HeartRateMock(SensorAdapter):
    provides = ["hr"]

    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        base_bpm: float = 68.0,
        noise: float = 1.5,
        # 이 조도 아래로 내려가면 신뢰도가 바닥, 위로 올라가면 만점에 수렴한다.
        dark_lux: float = 30.0,
        bright_lux: float = 120.0,
        conf_dark: float = 0.22,
        conf_bright: float = 0.88,
        thresholds_path: str = str(thresholds.DEFAULT_PATH),
    ) -> None:
        super().__init__(id, mode)
        self.base_bpm = base_bpm
        self.noise = noise
        self.dark_lux = dark_lux
        self.bright_lux = bright_lux
        self.conf_dark = conf_dark
        self.conf_bright = conf_bright
        self.thresholds_path = Path(thresholds_path)
        self._tick = 0
        self._gate = 0.4

    async def start(self) -> None:
        self._tick = 0
        # 게이트는 rppg 와 같은 곳에서 읽는다. mock 만 다른 기준으로 통과하면
        # 데모에서 본 동작이 실기에서 재현되지 않는다.
        self._gate = thresholds.load(self.thresholds_path).confidence_min

    async def stop(self) -> None:
        pass

    async def read(self) -> list[Metric]:
        self._tick += 1
        confidence = self._confidence(sim_room.lux())

        if confidence < self._gate:
            # 품질 미달이면 값을 지어내지 않고 보류한다 (README §0-4).
            return [self._metric(None, confidence, "low_quality")]

        bpm = self.base_bpm + 3.0 * math.sin(self._tick / 40.0) + random.gauss(0, self.noise)
        return [self._metric(round(bpm, 1), confidence, "ok")]

    def _confidence(self, lux: float) -> float:
        if lux <= self.dark_lux:
            return self.conf_dark
        if lux >= self.bright_lux:
            return self.conf_bright
        ratio = (lux - self.dark_lux) / (self.bright_lux - self.dark_lux)
        return self.conf_dark + ratio * (self.conf_bright - self.conf_dark)

    def _metric(self, value: float | None, confidence: float, state: State) -> Metric:
        return Metric(
            key="hr", value=value, unit="bpm", source=self.id,
            mode=self.mode, state=state, confidence=round(confidence, 3), ts=server_now(),
        )
