"""액추에이터 계약.

어댑터와 같은 규칙을 따른다. 파일 하나 추가가 곧 기능 추가고, config 해석은
registry 가 전담하며, mode 로 실측/시뮬레이션을 가른다.

mode 가 live 가 아니면 바깥 세계를 건드리지 않는다. 데모 중에 남의 집 전구를
켜는 사고를 막는 안전장치다.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Protocol, runtime_checkable

from api.schemas import Mode


class Actuator(ABC):
    id: str
    mode: Mode

    def __init__(self, id: str, mode: Mode) -> None:
        self.id = id
        self.mode = mode

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None:
        """정지 시 되돌릴 수 있는 개입은 원상복구한다."""


@runtime_checkable
class Notifier(Protocol):
    """사람에게 알릴 수 있는 액추에이터. L4 정책이 이 모양만 알면 된다.

    메일이든 메신저든 정책은 상관하지 않는다. 채널을 바꾸려면 파일 하나를
    더 떨어뜨리고 config 에서 갈아 끼우면 된다 (README §0-2).
    """

    id: str

    async def notify(self, subject: str, body: str) -> None: ...


@runtime_checkable
class Switch(Protocol):
    """켜고 끌 수 있는 액추에이터. L1 조명 정책이 이 모양만 알면 된다."""

    id: str

    async def turn_on(self) -> None: ...

    async def turn_off(self) -> None: ...

    @property
    def is_on(self) -> bool: ...
