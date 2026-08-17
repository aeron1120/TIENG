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


@runtime_checkable
class FrameSource(Protocol):
    """카메라 원본 프레임을 다른 어댑터에게 넘겨줄 수 있는 어댑터.

    카메라 하나를 두 어댑터가 각자 열 수는 없다. Windows 에서는 장치가 점유돼 아예
    실패하고, Linux 에서 열리더라도 두 스트림이 노출을 서로 흔들어 양쪽 측정이 다
    나빠진다 (api/routes/camera.py 에 같은 이유가 적혀 있다). 그래서 카메라를 가진
    어댑터가 프레임을 내보내고, 필요한 쪽이 받아 쓴다.

    PreviewSource 와 같은 모양으로 둔 이유도 같다 — 미리보기가 그랬듯 프레임 공유도
    지표 계약과 무관한 곁가지라, SensorAdapter 를 상속시키면 카메라를 안 쓰는
    어댑터까지 이 메서드를 갖게 된다.
    """

    def latest_frame(self) -> tuple[float, "object"] | None:
        """(캡처 시각(monotonic), BGR 프레임). 아직 없으면 None.

        호출자는 프레임을 **읽기만** 해야 한다. 캡처 스레드가 같은 버퍼를 다시 쓸 수
        있으므로, 오래 들고 있거나 고쳐 쓸 거면 복사해서 가져갈 것.
        """


@runtime_checkable
class OverlayTarget(Protocol):
    """미리보기 위에 남의 상자를 얹어 줄 수 있는 어댑터.

    프레임을 받아 쓰는 어댑터는 자기가 무엇을 보고 있는지 화면으로 보여 줄 방법이
    없다. 미리보기를 만드는 것은 카메라를 가진 쪽이기 때문이다. 그렇다고 미리보기를
    또 하나 만들면 같은 영상이 두 번 인코딩된다.

    그래서 "이 상자들을 이 색으로 그려 달라"만 넘긴다. 받는 쪽은 그게 눈인지 손인지
    모르고 알 필요도 없다 — 어댑터끼리 서로를 모르게 하는 규칙(README §0-2)이
    여기서도 유지된다.
    """

    def set_overlay(
        self,
        owner: str,
        boxes: list[tuple[int, int, int, int]],
        color: tuple[int, int, int],
    ) -> None:
        """owner 가 그리고 싶은 상자 목록. 원본 프레임 좌표계의 (x, y, w, h) 다.

        빈 목록을 넘기면 지운다. 매 프레임 덮어쓰는 것을 전제로 한다 — 남은 상자가
        화면에 걸려 있으면 이미 놓친 대상을 계속 잡고 있는 것처럼 보인다.
        """


@runtime_checkable
class Pausable(Protocol):
    """모드에 따라 쉴 수 있는 어댑터.

    카메라 하나와 CPU 를 나눠 쓰는 이상, 지금 안 보는 지표를 위해 매 프레임 얼굴을
    찾는 것은 그대로 낭비다. 쉬는 동안에도 어댑터는 살아 있고 값만 내지 않는다 —
    내렸다 올리면 창을 처음부터 다시 채워야 하기 때문이다.

    무엇을 언제 쉬게 할지는 어댑터가 정하지 않는다. config 의 modes 를 보고
    registry 가 불러 준다 (core/mode.py).
    """

    def set_active(self, active: bool) -> None:
        """False 면 프레임 처리를 멈추고 값을 내지 않는다."""


@runtime_checkable
class Releasable(Protocol):
    """보는 사람이 없으면 장치를 놓을 수 있는 어댑터.

    Pausable 과 다르다. 쉬는 것(set_active)은 장치를 든 채 처리만 멈추는 것이고,
    여기서는 장치 자체를 놓는다. 카메라는 켜져 있다는 사실만으로 사람을 불편하게
    하므로, 아무도 화면을 보고 있지 않으면 LED 까지 꺼져야 한다.

    놓는 동안 그 장치를 쓰는 지표는 멈춘다. 그 대가를 감수할지는 어댑터가 아니라
    부르는 쪽이 정한다 (api/ws.py 의 구독자 수).
    """

    async def acquire(self) -> None:
        """장치를 연다. 이미 열려 있으면 아무것도 하지 않는다."""

    async def release(self) -> None:
        """장치를 놓는다. 이미 놓았으면 아무것도 하지 않는다."""


@runtime_checkable
class SubjectAware(Protocol):
    """측정 대상이 누구인지 알아야 하는 어댑터.

    개인 기준선을 사람별로 쌓으려면 열쇠가 필요한데, 어댑터가 계정 체계를 알면
    안 된다. 그래서 이름 하나만 받는다 — 그게 계정인지 별명인지는 모른다.
    """

    def set_subject(self, subject: str) -> None:
        """측정 대상이 바뀌었다. 비우면 기기 공용으로 돌아간다."""


@runtime_checkable
class FrameConsumer(Protocol):
    """다른 어댑터의 프레임을 받아 도는 어댑터.

    registry 가 config 의 source 를 보고 start() 이후에 붙여 준다. 어댑터끼리 서로를
    찾지 않는 규칙은 그대로다 — 여기서도 주입받기만 한다.
    """

    source_id: str

    def attach_frames(self, source: FrameSource | None) -> None:
        """프레임 공급자를 연결한다. None 이면 공급자를 못 찾았다는 뜻이다."""


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
