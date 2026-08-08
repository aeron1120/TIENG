"""센서 어댑터 계약.

어댑터 파일 하나를 추가하는 것이 곧 기능 추가여야 한다 (README §0-2).
그래서 어댑터는 자기 자신 외에는 아무것도 모른다 — registry가 config를 읽어 주입한다.
"""

from abc import ABC, abstractmethod
from typing import Protocol, runtime_checkable

from api.schemas import Metric, Mode


@runtime_checkable
class PreviewSource(Protocol):
    """카메라 화면을 그대로 내보낼 수 있는 어댑터.

    SensorAdapter 를 상속하지 않고 따로 둔다. 미리보기는 지표 계약과 아무 상관이
    없고, 어댑터 대부분은 카메라를 쓰지 않기 때문이다. 이 두 메서드만 가지고 있으면
    registry 가 알아서 찾아 스트림에 물린다 — 카메라 어댑터가 하나 더 붙어도
    다른 파일은 손대지 않는다 (README §0-2).
    """

    def request_preview(self) -> None:
        """지금 보고 있는 사람이 있다는 신호. 아무도 안 보면 인코딩하지 않는다."""

    def preview_jpeg(self) -> bytes | None:
        """가장 최근 프레임의 JPEG. 아직 없으면 None."""


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
