"""카메라를 소유하는 어댑터. 지표는 내지 않는다.

장치 하나를 두 번 열 수 없다는 물리적 사실을 한 파일에 가둔다. 예전에는 rPPG 가
카메라를 들고 있고 졸음 어댑터가 거기에 얹혀 있었는데, 그러면 심박을 끄는 순간
졸음도 같이 죽는다 — 의존 방향이 제품의 중심과 반대가 된다.

여기서는 카메라만 소유하고 프레임을 나눠 준다. 누가 무엇을 재는지는 모른다.

    camera  ──FrameSource──▶  rppg        (볼 ROI → 심박)
                          └─▶  drowsiness  (눈 ROI → 졸음)

미리보기도 여기서 만든다. 소비자마다 미리보기를 만들면 같은 영상을 여러 번
인코딩하게 되므로, 소비자들은 자기가 보고 있는 영역만 OverlayTarget 으로 맡긴다.

지표를 하나도 내지 않는 어댑터라 provides 가 비어 있다. registry 계약상 문제는
없다 — read() 가 빈 목록을 돌려주면 카드가 생기지 않을 뿐이다. 카메라는 지표가
아니라 장치이므로 이게 맞다.
"""

from __future__ import annotations

import asyncio
import platform
import threading
import time
from typing import Any

import cv2
import numpy as np
import structlog

from api.schemas import Metric
from core.adapters.base import SensorAdapter

log = structlog.get_logger(__name__)

READ_FAIL_LIMIT = 30  # 연속 실패가 이만큼이면 카메라가 빠진 것으로 본다

PREVIEW_WIDTH = 320  # 관심 영역이 제자리인지 보는 용도라 이 이상 필요 없다
PREVIEW_FPS = 10.0
PREVIEW_QUALITY = 70
PREVIEW_LINGER_SEC = 3.0  # 마지막 요청 후 이만큼 지나면 인코딩을 멈춘다
FRAME_SHARE_LINGER_SEC = 3.0  # 받아 가는 쪽이 끊기면 이만큼 뒤 들고 있기를 멈춘다


class CameraAdapter(SensorAdapter):
    provides: list[str] = []

    def __init__(
        self,
        id: str,
        mode: Any,
        *,
        camera_index: int = 0,
        width: int = 1280,
        height: int = 720,
        fps: float | None = None,
        backend: str = "opencv",
    ) -> None:
        super().__init__(id, mode)
        # 자동 감지하지 않는다. USB 와 CSI 가 둘 다 꽂힌 기기에서 어느 쪽을 고를지
        # 규칙이 지저분해지고, 오타가 조용히 opencv 로 떨어지면 엉뚱한 카메라가 열린다.
        if backend not in ("opencv", "picamera2"):
            raise ValueError(f"backend 는 opencv 또는 picamera2 여야 한다: {backend!r}")
        self.camera_index = camera_index
        self.width = width
        self.height = height
        self.fps = fps
        self.backend = backend

        self._cap: Any = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        # 획득과 반납이 겹치면 장치를 두 번 열거나 스레드가 둘 남는다. 구독자가
        # 유예 시간 안에 나갔다 들어오면 실제로 겹친다.
        self._gate = asyncio.Lock()

        # 아래는 전부 _lock 으로 보호한다.
        self._frame: np.ndarray | None = None
        self._frame_t = 0.0
        self._frames_until = 0.0
        self._preview: bytes | None = None
        self._preview_until = 0.0
        self._fault: str | None = None
        # 실측 프레임률. 요청값이 아니라 실제로 들어오는 속도다 — 드라이버가 60 을
        # 보고하면서 30 만 주는 경우가 실제로 있었다. 졸음 쪽 정확도가 여기 달렸으므로
        # (눈깜빡임 100~400ms) 숨기지 않고 내보낸다.
        self._fps = 0.0
        # 남이 그려 달라고 맡긴 상자. {주인: (상자들, 색)}. 무엇을 뜻하는지는 모른다.
        self._overlays: dict[str, tuple[list[tuple[int, int, int, int]], tuple[int, int, int]]] = {}

    # --- 수명주기 ----------------------------------------------------------- #

    async def start(self) -> None:
        # 기동 때 한 번 연다. 장치가 없으면 여기서 실패해 registry 가 사유를 잡는다 —
        # 첫 구독자가 붙는 순간까지 그걸 모르고 있으면 시연 중에 발견하게 된다.
        await self.acquire()

    async def stop(self) -> None:
        await self.release()

    async def acquire(self) -> None:
        """Releasable. 이미 열려 있으면 아무것도 하지 않는다."""
        async with self._gate:
            if self._thread is not None:
                return
            loop = asyncio.get_running_loop()
            self._cap = await loop.run_in_executor(None, self._open)
            if self._cap is None:
                raise RuntimeError(f"카메라 {self.camera_index} 를 열 수 없다")
            self._stop.clear()
            with self._lock:
                # 놓았다 다시 여는 것이므로 지난번 고장은 지운다. 남겨 두면 새로 연
                # 카메라가 멀쩡한데도 read() 가 계속 예외를 던진다.
                self._fault = None
                self._fps = 0.0
            self._thread = threading.Thread(
                target=self._loop, name=f"camera-{self.id}", daemon=True
            )
            self._thread.start()
            log.info(
                "camera.started",
                adapter=self.id,
                backend=self.backend,
                size=f"{self.width}x{self.height}",
            )

    async def release(self) -> None:
        """Releasable. 이미 놓았으면 아무것도 하지 않는다."""
        async with self._gate:
            if self._thread is None and self._cap is None:
                return
            # join 과 release 는 최대 3초까지 걸린다. 이벤트 루프에서 직접 하면
            # 그동안 스냅샷 브로드캐스트가 통째로 멎는다. 종료할 때만 부르던
            # 코드였으나 이제는 사람이 화면을 닫을 때마다 불린다.
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._close)
            log.info("camera.released", adapter=self.id)

    def _close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        with self._lock:
            self._frame = None
            self._preview = None
            self._fault = None

    async def read(self) -> list[Metric]:
        """지표가 없다. 카메라가 죽은 것만 알린다 — registry 가 사유를 화면에 싣는다."""
        with self._lock:
            fault = self._fault
        if fault is not None:
            raise RuntimeError(fault)
        return []

    # --- FrameSource -------------------------------------------------------- #

    def latest_frame(self) -> tuple[float, np.ndarray] | None:
        """가장 최근 BGR 프레임과 캡처 시각(monotonic).

        부르는 것 자체가 "받아 갈 사람이 있다"는 신호다. 아무도 안 부르면 캡처
        루프는 프레임을 들고 있지도 않으므로 첫 호출은 None 이 정상이다.
        """
        with self._lock:
            self._frames_until = time.monotonic() + FRAME_SHARE_LINGER_SEC
            if self._frame is None:
                return None
            return self._frame_t, self._frame

    # --- PreviewSource ------------------------------------------------------ #

    def request_preview(self) -> None:
        with self._lock:
            self._preview_until = time.monotonic() + PREVIEW_LINGER_SEC

    def preview_jpeg(self) -> bytes | None:
        with self._lock:
            return self._preview

    # --- OverlayTarget ------------------------------------------------------ #

    def set_overlay(
        self,
        owner: str,
        boxes: list[tuple[int, int, int, int]],
        color: tuple[int, int, int],
    ) -> None:
        with self._lock:
            self._overlays[owner] = (list(boxes), color)

    # --- 캡처 --------------------------------------------------------------- #

    @property
    def measured_fps(self) -> float:
        with self._lock:
            return self._fps

    def _loop(self) -> None:
        assert self._cap is not None
        failures = 0
        next_preview = 0.0
        prev_t = 0.0
        logged = 0.0

        while not self._stop.is_set():
            ok, frame = self._cap.read()
            if not ok or frame is None:
                failures += 1
                if failures >= READ_FAIL_LIMIT:
                    with self._lock:
                        self._fault = "카메라 프레임을 연속으로 못 읽었다"
                        # 마지막 프레임을 버린다. 안 버리면 카메라가 빠진 뒤에도
                        # 죽은 프레임이 실시간 영상인 것처럼 나간다 (README §0-4).
                        self._frame = None
                        self._preview = None
                    return
                time.sleep(0.01)
                continue
            failures = 0

            now = time.monotonic()  # 신호 타이밍은 벽시계가 아니라 단조시계를 쓴다
            if prev_t:
                # EMA. 한 프레임 늦은 것 때문에 값이 튀면 읽는 사람이 헷갈린다.
                instant = 1.0 / max(now - prev_t, 1e-6)
                self._fps = instant if self._fps == 0.0 else 0.9 * self._fps + 0.1 * instant
            prev_t = now
            if now - logged > 30.0:
                logged = now
                log.info("camera.fps", adapter=self.id, fps=round(self._fps, 1))
            with self._lock:
                if now < self._frames_until:
                    self._frame, self._frame_t = frame, now
                else:
                    self._frame = None
                watching = now < self._preview_until

            # 미리보기는 보는 사람이 있을 때만 만든다. 아무도 안 보는데 매 프레임
            # JPEG 을 굽는 건 Pi 에서 그대로 FPS 손해다.
            if watching and now >= next_preview:
                next_preview = now + 1.0 / PREVIEW_FPS
                self._publish_preview(frame)

    def _publish_preview(self, frame: np.ndarray) -> None:
        """축소본 JPEG 하나를 들고 있는다. 맡아 둔 상자를 같이 그린다.

        상자를 그리는 이유는 신뢰도가 낮을 때 "왜"를 화면에서 바로 알기 위해서다 —
        얼굴을 놓쳤는지, 관심 영역이 엉뚱한 데 가 있는지가 보인다.
        """
        height, width = frame.shape[:2]
        scale = PREVIEW_WIDTH / float(width)
        small = cv2.resize(frame, (PREVIEW_WIDTH, max(1, round(height * scale))))

        with self._lock:
            overlays = list(self._overlays.values())
        for rects, color in overlays:
            for x, y, w, h in rects:
                cv2.rectangle(
                    small,
                    (round(x * scale), round(y * scale)),
                    (round((x + w) * scale), round((y + h) * scale)),
                    color,
                    1,
                )

        # 거울상으로 뒤집는다. 화면을 보면서 자세를 잡는 용도라 좌우가 그대로면
        # 오른쪽으로 움직였는데 화면은 왼쪽으로 가서 맞추기가 어렵다.
        ok, buf = cv2.imencode(
            ".jpg", cv2.flip(small, 1), [int(cv2.IMWRITE_JPEG_QUALITY), PREVIEW_QUALITY]
        )
        if not ok:
            return
        with self._lock:
            self._preview = buf.tobytes()

    def _open(self) -> Any:
        if self.backend == "picamera2":
            return _open_picamera2(self.camera_index, self.width, self.height)

        backends: list[int] = []
        if platform.system().lower().startswith("win"):
            backends += [cv2.CAP_DSHOW, cv2.CAP_MSMF]
        backends.append(0)
        for backend in backends:
            cap = (
                cv2.VideoCapture(self.camera_index, backend)
                if backend
                else cv2.VideoCapture(self.camera_index)
            )
            if not cap.isOpened():
                cap.release()
                continue
            if self.fps and self.fps > 30:
                # 30fps 를 넘기려면 대부분의 웹캠이 MJPG 를 요구한다. 무압축(YUY2)은
                # USB 대역이 모자라 조용히 30 으로 떨어진다.
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
            if self.fps:
                cap.set(cv2.CAP_PROP_FPS, self.fps)
            return cap
        return None


class _Picamera2Capture:
    """Picamera2 를 cv2.VideoCapture 처럼 보이게 감싼다."""

    def __init__(self, camera: Any) -> None:
        self._camera = camera

    def read(self) -> tuple[bool, np.ndarray | None]:
        try:
            frame = self._camera.capture_array()
        except Exception as exc:
            log.warning("camera.picamera2_read_failed", error=str(exc))
            return False, None
        return True, cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)

    def release(self) -> None:
        try:
            self._camera.stop()
            self._camera.close()
        except Exception:
            pass


def _open_picamera2(camera_index: int, width: int, height: int) -> _Picamera2Capture:
    """CSI 리본 카메라를 연다.

    CSI 는 cv2.VideoCapture 로 쓸 수 없다. libcamera 를 거치는 Picamera2 로 연다.
    picamera2 는 libcamera 파이썬 바인딩에 묶여 있어 apt 로만 깔린다 — 그래서 여기서
    늦게 import 한다 (없는 기기에서는 이 어댑터만 못 뜨고 나머지는 그대로 돈다).
    """
    from picamera2 import Picamera2

    camera = Picamera2(camera_index)
    camera.configure(
        camera.create_video_configuration(main={"size": (width, height), "format": "RGB888"})
    )
    camera.start()
    return _Picamera2Capture(camera)
