"""카메라 어댑터 계약. 프레임 공유와 미리보기.

rPPG 에 있던 검사를 옮겨왔다. 카메라 소유가 rppg 에서 camera 로 넘어가면서
"아무도 안 볼 때는 일하지 않는다"와 "죽은 프레임을 내보내지 않는다"도 같이
넘어왔기 때문이다.
"""

import numpy as np

from core.adapters.camera import CameraAdapter


class _FakeCamera:
    """프레임 몇 장을 준 뒤 멈추거나(stop) 고장 나는(fault) 카메라."""

    def __init__(self, adapter: CameraAdapter, frames: int, *, then_fail: bool) -> None:
        self.adapter = adapter
        self.left = frames
        self.then_fail = then_fail

    def read(self) -> tuple[bool, np.ndarray | None]:
        if self.left <= 0:
            if not self.then_fail:
                # 정상 종료. stop() 이 부른 것과 같은 상태로 루프를 빠져나간다.
                self.adapter._stop.set()
                return True, np.full((480, 640, 3), 160, dtype=np.uint8)
            return False, None
        self.left -= 1
        return True, np.full((480, 640, 3), 160, dtype=np.uint8)

    def release(self) -> None: ...


def _capture(adapter: CameraAdapter, frames: int, *, then_fail: bool = False) -> None:
    """캡처 루프를 스레드 없이 그 자리에서 돌린다."""
    adapter._cap = _FakeCamera(adapter, frames, then_fail=then_fail)
    adapter._loop()


# --- 미리보기 ------------------------------------------------------------- #


def test_preview_is_not_encoded_until_someone_watches() -> None:
    """아무도 안 보는데 매 프레임 JPEG 을 굽는 건 파이에서 그대로 FPS 손해다."""
    adapter = CameraAdapter(id="cam", mode="live")
    _capture(adapter, frames=5)

    assert adapter.preview_jpeg() is None


def test_preview_appears_once_requested() -> None:
    adapter = CameraAdapter(id="cam", mode="live")
    adapter.request_preview()
    _capture(adapter, frames=5)

    frame = adapter.preview_jpeg()
    assert frame is not None
    assert frame[:2] == b"\xff\xd8"  # JPEG SOI


def test_dead_camera_drops_its_last_frame() -> None:
    """카메라가 빠진 뒤 화면을 연 사람에게 죽은 프레임이 실시간인 척 나가면 안 된다."""
    adapter = CameraAdapter(id="cam", mode="live")
    adapter.request_preview()
    _capture(adapter, frames=3, then_fail=True)

    assert adapter._fault is not None
    assert adapter.preview_jpeg() is None


def test_overlay_changes_what_the_preview_shows() -> None:
    """맡긴 상자가 실제로 그려져야 관심 영역이 제자리인지 화면에서 볼 수 있다."""
    plain = CameraAdapter(id="cam", mode="live")
    plain.request_preview()
    _capture(plain, frames=3)

    boxed = CameraAdapter(id="cam", mode="live")
    boxed.request_preview()
    boxed.set_overlay("someone", [(100, 100, 200, 150)], (0, 0, 255))
    _capture(boxed, frames=3)

    assert plain.preview_jpeg() != boxed.preview_jpeg()


# --- 프레임 공유 ---------------------------------------------------------- #


def test_frames_are_not_kept_until_someone_asks() -> None:
    """받아 갈 어댑터가 없으면 프레임을 들고 있지도 않는다 (미리보기와 같은 규칙)."""
    adapter = CameraAdapter(id="cam", mode="live")
    _capture(adapter, frames=5)

    assert adapter.latest_frame() is None


def test_frames_flow_once_requested() -> None:
    adapter = CameraAdapter(id="cam", mode="live")
    adapter.latest_frame()  # 부르는 것 자체가 "받아 갈 사람이 있다"는 신호다
    _capture(adapter, frames=5)

    got = adapter.latest_frame()
    assert got is not None
    ts, frame = got
    assert ts > 0.0
    assert frame.shape == (480, 640, 3)


def test_camera_reports_no_metrics() -> None:
    """카메라는 장치지 지표가 아니다. 카드를 만들지 않는다."""
    import asyncio

    adapter = CameraAdapter(id="cam", mode="live")
    assert adapter.provides == []
    assert asyncio.run(adapter.read()) == []
