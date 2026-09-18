"""backend 를 받는 가짜 카메라 어댑터. registry 의 동적 로드 경로를 그대로 태운다.

진짜 rppg 를 쓰면 opencv 경로에서 이 PC 의 웹캠을 실제로 연다. 테스트가 카메라 불을
켜서도 안 되고, 웹캠이 달렸느냐로 결과가 갈려서도 안 된다.

개발 PC 를 흉내 내서 picamera2 는 항상 거절한다 — CSI 리본이 없는 기기에서 실제로
일어나는 일이고, backend 를 바꿔 보는 것도 대개 그 상황이기 때문이다.
"""

from __future__ import annotations

from api.schemas import Metric, Mode, server_now
from core.adapters.base import SensorAdapter


class FakeCamera(SensorAdapter):
    provides = ["hr"]

    def __init__(self, id: str, mode: Mode, *, backend: str = "opencv") -> None:
        super().__init__(id, mode)
        self.backend = backend

    async def start(self) -> None:
        if self.backend == "picamera2":
            raise RuntimeError("libcamera 가 잡은 카메라는 0대인데 camera_index=0 를 찾는다")

    async def read(self) -> list[Metric]:
        return [
            Metric(
                key="hr", value=70.0, unit="bpm", source=self.id,
                mode=self.mode, state="ok", confidence=0.9, ts=server_now(),
            )
        ]

    async def stop(self) -> None:
        pass
