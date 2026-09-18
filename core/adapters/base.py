"""센서 어댑터 계약 (CLAUDE.md §4).

어댑터를 하나 추가하는 것이 곧 기능 추가여야 한다 (§0-2). 그래서 어댑터는 자기
자신 외에는 아무것도 모른다 — 자기 스레드에서 자기 큐에 샘플을 넣고, 파이프라인이
꺼내 간다 (§5).

어떤 어댑터가 죽어도 파이프라인은 계속 돈다 (§0-3). 예외는 note_error 로 삼키고
health() 로만 보고한다. 루프를 멈추는 어댑터는 없다.
"""

from __future__ import annotations

import queue
import threading
from abc import ABC, abstractmethod
from typing import Generic, TypeVar

from core.schemas import Mode

SampleT = TypeVar("SampleT")


class SensorAdapter(ABC, Generic[SampleT]):
    id: str
    mode: Mode

    def __init__(self, id: str, mode: Mode, maxsize: int = 200_000) -> None:
        self.id = id
        self.mode = mode
        self._queue: queue.Queue[SampleT] = queue.Queue(maxsize=maxsize)
        self._dropped = 0
        self._errors = 0
        self._last_error = ""
        self._stopping = threading.Event()

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...

    # --- 파이프라인이 부르는 쪽 ------------------------------------------- #

    def drain(self) -> list[SampleT]:
        """도착한 샘플을 전부 꺼낸다. 융합 루프가 매 틱 부른다 (§5)."""
        out: list[SampleT] = []
        while True:
            try:
                out.append(self._queue.get_nowait())
            except queue.Empty:
                return out

    def health(self) -> dict[str, float]:
        """드롭·오류·큐 깊이 (§4, §12). 화면에서 바로 읽혀야 배선을 고칠 수 있다."""
        return {
            f"{self.id}.dropped": float(self._dropped),
            f"{self.id}.errors": float(self._errors),
            f"{self.id}.queued": float(self._queue.qsize()),
        }

    @property
    def last_error(self) -> str:
        return self._last_error

    # --- 어댑터가 부르는 쪽 ----------------------------------------------- #

    def push(self, sample: SampleT) -> None:
        """실시간 소스용. 큐가 꽉 차면 **새 것을 버리고** 센다.

        오래된 것을 밀어내지 않는 이유는 §4 다 — 결측 구간은 보간하지 않고 구멍으로
        남긴다. 오래된 것을 버리면 이미 기록된 구간과 뒤섞여 구멍의 위치를 잃는다.
        """
        try:
            self._queue.put_nowait(sample)
        except queue.Full:
            self._dropped += 1

    def push_blocking(self, sample: SampleT) -> bool:
        """파일 소스용. 버리지 않고 자리가 날 때까지 기다린다.

        리플레이에서 한 샘플이라도 버리면 두 번 돌린 결과가 달라진다 (§9). 파일은
        센서와 달리 기다려 준다고 데이터가 상하지 않으므로 여기서는 막아도 된다.
        """
        while not self._stopping.is_set():
            try:
                self._queue.put(sample, timeout=0.05)
            except queue.Full:
                continue
            return True
        return False

    def note_error(self, exc: Exception) -> None:
        """예외를 삼키고 센다. 어댑터 하나가 루프를 멈추면 안 된다 (§0-3)."""
        self._errors += 1
        self._last_error = str(exc)
