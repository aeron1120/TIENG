"""세션 리플레이 (CLAUDE.md §4, §13-3).

세션 디렉터리를 읽어 **원래 타임스탬프 순서대로** 샘플을 방출한다. 실시간 모드와
같은 인터페이스라, 파이프라인은 자기가 리플레이 중인지 몰라야 한다.

실시간 속도로 재생하지 않는다. 순서만 지키면 융합 결과는 같고 (지표는 t 를 보지
벽시계를 보지 않는다, §0-5), 튜닝은 주행 시간만큼 기다릴 이유가 없다.

한 샘플도 버리지 않는다 — push_blocking 을 쓰는 이유가 §9 다.
"""

from __future__ import annotations

import threading
from pathlib import Path

from core.adapters.base import SensorAdapter
from core.recorder import read_stream
from core.schemas import ImuSample


class ImuReplay(SensorAdapter[ImuSample]):
    def __init__(self, session_dir: Path, id: str = "imu_replay") -> None:
        super().__init__(id=id, mode="replay")
        self.session_dir = Path(session_dir)
        self._thread: threading.Thread | None = None
        self._done = threading.Event()

    @property
    def finished(self) -> bool:
        """방출이 끝났는지. 파이프라인이 리플레이를 언제 멈출지 판단한다."""
        return self._done.is_set()

    def start(self) -> None:
        self._stopping.clear()
        self._done.clear()
        self._thread = threading.Thread(target=self._run, name=self.id, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None

    def _run(self) -> None:
        try:
            samples = read_stream(self.session_dir, "imu", ImuSample)
            # 기록 순서를 믿지 않고 t 로 다시 세운다. 어댑터가 여럿이면 배치 경계에서
            # 순서가 섞일 수 있고, 그러면 두 번 돌린 결과가 달라진다 (§9).
            samples.sort(key=lambda s: (s.t, s.seq))
            for sample in samples:
                if not self.push_blocking(sample):
                    return
        except Exception as exc:  # noqa: BLE001 - 어댑터는 루프를 멈추지 않는다
            self.note_error(exc)
        finally:
            self._done.set()
