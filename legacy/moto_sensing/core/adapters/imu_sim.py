"""합성 IMU (CLAUDE.md §13-2, mode="simulated").

센서 없이 파이프라인 구조를 검증한다 (§11 `--source sim`).

t 를 읽은 시각으로 찍지 않고 **표본 번호와 ODR 로 역산한다**. 실기 어댑터가 FIFO
카운트로 하는 것과 같은 규칙이다 (§4). 읽은 시각으로 찍으면 스케줄러 지터가 그대로
타임스탬프에 섞여 들어가고, 그게 §12 표의 첫 줄에 있는 증상이다.

신호는 seed 로 고정한다. 같은 seed 면 같은 세션이 나와야 §9 의 결정성 테스트가
"리플레이가 깨진 것"과 "소스가 원래 다른 것"을 구분할 수 있다.
"""

from __future__ import annotations

import math
import random
import threading
import time

from core.adapters.base import SensorAdapter
from core.schemas import ImuSample

GRAVITY = 9.80665


class ImuSim(SensorAdapter[ImuSample]):
    def __init__(
        self,
        id: str = "imu_sim",
        *,
        odr_hz: int = 1000,
        batch_ms: int = 20,
        seed: int = 0,
        noise: float = 0.02,
    ) -> None:
        super().__init__(id=id, mode="simulated")
        self.odr_hz = odr_hz
        self.batch_ms = batch_ms
        self.seed = seed
        self.noise = noise
        self._seq = 0
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stopping.clear()
        self._thread = threading.Thread(target=self._run, name=self.id, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _run(self) -> None:
        rng = random.Random(self.seed)
        per_batch = max(1, round(self.odr_hz * self.batch_ms / 1000))
        period = self.batch_ms / 1000.0
        next_at = time.monotonic()

        while not self._stopping.is_set():
            try:
                for _ in range(per_batch):
                    self.push(self._sample(rng))
            except Exception as exc:  # noqa: BLE001 - 어댑터는 루프를 멈추지 않는다
                self.note_error(exc)

            next_at += period
            # 절대 시각 기준으로 맞춘다. sleep(period) 만 쓰면 생성 시간만큼 주기가 밀린다.
            time.sleep(max(0.0, next_at - time.monotonic()))

    def _sample(self, rng: random.Random) -> ImuSample:
        t = self._seq / self.odr_hz
        # 완만한 선회를 흉내 낸다. 0.2Hz 로 좌우 20도.
        roll = math.radians(20.0) * math.sin(2.0 * math.pi * 0.2 * t)
        sample = ImuSample(
            t=t,
            ax=rng.gauss(0.0, self.noise),
            ay=GRAVITY * math.sin(roll) + rng.gauss(0.0, self.noise),
            az=GRAVITY * math.cos(roll) + rng.gauss(0.0, self.noise),
            gx=math.radians(20.0) * 2.0 * math.pi * 0.2 * math.cos(2.0 * math.pi * 0.2 * t),
            gy=rng.gauss(0.0, self.noise * 0.1),
            gz=rng.gauss(0.0, self.noise * 0.1),
            temp=None,
            seq=self._seq,
            source="sim",
        )
        self._seq += 1
        return sample
