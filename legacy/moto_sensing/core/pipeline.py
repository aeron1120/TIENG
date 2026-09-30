"""파이프라인 (CLAUDE.md §5, §13-2·3).

고정 틱으로 돌면서 어댑터 큐를 비우고, 도착한 것을 기록하고, 스냅샷을 갱신한다.

아직 융합(§13-8)도 지표(§13-9)도 없다. 그래서 스냅샷의 fused 는 None 이고
indicators 는 비어 있다 — 값을 지어내지 않는다 (§0-4). 지금 이 단계에서 진짜인
것은 health 뿐이고, §12 의 증상 표가 보라는 것도 그 숫자들이다.
"""

from __future__ import annotations

import argparse
import threading
import time
from pathlib import Path
from typing import Any

from core import config as config_mod
from core.adapters.base import SensorAdapter
from core.adapters.imu_sim import ImuSim
from core.adapters.replay import ImuReplay
from core.clock import SessionClock
from core.console import force_utf8
from core.recorder import SessionRecorder, git_commit
from core.schemas import ImuSample, Mode, Snapshot


def build_source(
    cfg: config_mod.Config, source: str, session_dir: Path | None
) -> tuple[SensorAdapter[ImuSample], Mode]:
    if source == "sim":
        imu = cfg.adapters.imu
        return ImuSim(odr_hz=imu.odr_hz, batch_ms=imu.fifo_batch_ms), "simulated"
    if source == "replay":
        if session_dir is None:
            raise SystemExit("--source replay 는 --session 이 필요하다")
        return ImuReplay(session_dir), "replay"
    raise SystemExit(f"아직 없는 소스다: {source} (지금은 sim | replay)")


class Pipeline:
    def __init__(
        self, cfg: config_mod.Config, source: str, session_dir: Path | None = None
    ) -> None:
        self.cfg = cfg
        self.clock = SessionClock()
        self.imu, self.mode = build_source(cfg, source, session_dir)
        self.recorder = SessionRecorder(
            Path(cfg.recording.session_dir), self.clock.dir_name(cfg.device_id)
        )
        self.latest: Snapshot | None = None
        self._tick_max_late = 0.0
        self._ticks = 0
        self._stopping = threading.Event()

    @property
    def session_id(self) -> str:
        return self.recorder.dir.name

    def open(self) -> None:
        if not self.cfg.recording.enabled:
            # 디렉터리조차 만들지 않는다. 빈 세션 폴더가 쌓이면 나중에 진짜
            # 주행 기록과 구분이 안 된다.
            self.imu.start()
            return
        self.recorder.open({
            "started_wall": self.clock.started_wall,
            "device_id": self.cfg.device_id,
            "mode": self.mode,
            "git_commit": git_commit(),
            # 설정을 통째로 박제한다. 이게 없으면 나중에 이 데이터가 무슨 설정으로
            # 찍힌 건지 알 수 없어 전부 못 쓴다 (§8).
            "config": self.cfg.model_dump(),
        })
        self.imu.start()

    def close(self) -> None:
        self.imu.stop()
        tail = self.imu.drain()  # 마지막 남은 것까지
        if self.cfg.recording.enabled:
            self.recorder.add("imu", tail)
            self.recorder.close()

    def tick(self) -> Snapshot:
        samples = self.imu.drain()
        if samples and self.cfg.recording.enabled:
            self.recorder.add("imu", samples)

        health = dict(self.imu.health())
        health["tick.max_late_ms"] = self._tick_max_late * 1000.0
        health["tick.count"] = float(self._ticks)
        health["imu.samples"] = float(len(samples))

        snapshot = Snapshot(
            device_id=self.cfg.device_id,
            session_id=self.session_id,
            t=self.clock.now(),
            mode=self.mode,
            fused=None,  # §13-8 전까지는 없다
            indicators=[],  # §13-9 전까지는 없다
            recent_events=[],
            health=health,
        )
        self.latest = snapshot
        return snapshot

    def run(self, seconds: float | None = None) -> Path:
        period = 1.0 / self.cfg.fusion.loop_hz
        next_at = time.monotonic()
        self.open()
        try:
            while not self._stopping.is_set():
                self.tick()
                if seconds is not None and self.clock.now() >= seconds:
                    break
                if isinstance(self.imu, ImuReplay) and self.imu.finished:
                    self.tick()  # 큐에 남은 꼬리를 비운다
                    break

                next_at += period
                late = time.monotonic() - next_at
                self._tick_max_late = max(self._tick_max_late, late)
                self._ticks += 1
                time.sleep(max(0.0, -late))
        finally:
            self.close()
        return self.recorder.dir

    def stop(self) -> None:
        self._stopping.set()


def main(argv: list[str] | None = None) -> None:
    force_utf8()  # 세션 요약을 파이프로 넘겨도 깨지지 않게 한다
    parser = argparse.ArgumentParser(prog="core.pipeline")
    parser.add_argument("--config", type=Path, default=config_mod.DEFAULT_PATH)
    parser.add_argument("--source", default="sim", choices=["sim", "replay"])
    parser.add_argument("--session", type=Path, default=None, help="--source replay 의 입력")
    parser.add_argument("--seconds", type=float, default=None)
    args = parser.parse_args(argv)

    cfg = config_mod.load(args.config)
    pipeline = Pipeline(cfg, args.source, args.session)
    out = pipeline.run(args.seconds)

    health: dict[str, Any] = pipeline.latest.health if pipeline.latest else {}
    if cfg.recording.enabled:
        print(f"세션 {out}")
    else:
        print("기록 꺼짐 — 디렉터리를 만들지 않았다 (recording.enabled: false)")
    for key in sorted(health):
        print(f"  {key:<22}{health[key]:.3f}")


if __name__ == "__main__":
    main()
