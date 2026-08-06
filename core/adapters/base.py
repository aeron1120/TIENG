"""센서 어댑터 계약.

어댑터 파일 하나를 추가하는 것이 곧 기능 추가여야 한다 (README §0-2).
그래서 어댑터는 자기 자신 외에는 아무것도 모른다 — registry가 config를 읽어 주입한다.
"""

from abc import ABC, abstractmethod

from api.schemas import Metric, Mode


class SensorAdapter(ABC):
    id: str
    provides: list[str]  # 이 어댑터가 내보내는 metric key 목록
    mode: Mode  # config에서 주입

    def __init__(self, id: str, mode: Mode) -> None:
        self.id = id
        self.mode = mode

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def read(self) -> list[Metric]:
        """실패 시 예외를 던져도 된다. registry가 잡아 state=error로 강등한다."""

    @abstractmethod
    async def stop(self) -> None: ...
