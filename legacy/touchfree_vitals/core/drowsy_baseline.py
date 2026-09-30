"""졸음 기준선을 주행 사이에 이어 붙인다.

음성 대조에서 나온 결론이 이 파일의 이유다. 각성 상태로 12분을 앉아 있었는데
66% 의 시간이 "주의 이상"으로 떴고, 원인은 임계가 아니라 **기준선이 걸친 시간**
이었다. 채널별 표준편차를 창 길이별로 재 보니 이랬다.

    채널          30초   60초  120초  300초  12분
    reopen_ms     14.5   22.7   31.3   34.7  45.0
    blink_dur     17.6   28.2   40.1   46.4  57.7
    blink_rate     4.7    7.4    9.8   12.3  12.8
    perclos        1.8    2.9    3.9    5.1   6.3

전부 단조 증가하고 300초에서도 평평해지지 않는다. 90초짜리 기준선은 σ 를 약 3배
과소평가했고, 그래서 원래 1σ 인 정상 변동이 3σ(만점)로 들어갔다.

제대로 재려면 몇 분이 필요한데 운전자는 시동 걸고 기다리지 않는다. 그래서 한 번에
길게 재는 대신 **주행마다 조금씩 쌓는다.** 둘째 주행부터는 기다림이 없고, 쓸수록
σ 가 실제 값에 가까워진다.

표본을 다 들고 있지 않고 합·제곱합만 남긴다 — 파일이 자라지 않고, 두 세션을 합치는
것이 덧셈 한 번이면 된다.
"""

from __future__ import annotations

import math
from pathlib import Path

import structlog
from pydantic import BaseModel, Field

log = structlog.get_logger(__name__)

DEFAULT_PATH = Path("state/drowsy_baseline.json")

# 이만큼은 모여야 그 채널을 믿는다. 세션 하나(30표본)로는 모자라고, 두세 번
# 주행하면 넘는다.
MIN_SAMPLES = 60

# 카메라 각도가 바뀌면 절대값이 통째로 달라지는 채널. 평균은 이번 세션 것을 쓰고
# 표준편차만 누적분을 빌린다 — 흔들리는 폭은 각도가 바뀌어도 비슷하기 때문이다.
POSE_CHANNELS = frozenset({"pitch"})


class ChannelStats(BaseModel):
    """합과 제곱합만. 표본을 다 들고 있지 않아도 평균과 표준편차가 나온다."""

    n: int = 0
    total: float = 0.0
    total_sq: float = 0.0

    def add(self, value: float) -> None:
        self.n += 1
        self.total += value
        self.total_sq += value * value

    @property
    def mean(self) -> float:
        return self.total / self.n if self.n else 0.0

    @property
    def sd(self) -> float:
        if self.n < 2:
            return 0.0
        # 부동소수 오차로 음수가 나올 수 있다 (값이 거의 같을 때).
        var = max(self.total_sq / self.n - self.mean**2, 0.0)
        return math.sqrt(var)


class Baseline(BaseModel):
    """어댑터 하나가 쌓아 온 것. sessions 는 몇 번 주행분이 들었는지."""

    sessions: int = 0
    channels: dict[str, ChannelStats] = Field(default_factory=dict)

    def add(self, key: str, value: float) -> None:
        self.channels.setdefault(key, ChannelStats()).add(value)

    def ready(self) -> bool:
        return bool(self.channels) and all(c.n >= MIN_SAMPLES for c in self.channels.values())

    def as_stats(self) -> dict[str, tuple[float, float]]:
        """{채널: (평균, 표준편차)}. 표본이 모자란 채널은 뺀다."""
        return {
            key: (c.mean, c.sd) for key, c in self.channels.items() if c.n >= MIN_SAMPLES
        }


class Store(BaseModel):
    """어댑터 id -> 기준선. 한 기기에 졸음 어댑터가 둘 붙어도 섞이지 않는다."""

    adapters: dict[str, Baseline] = Field(default_factory=dict)


def load(path: Path | None = None) -> Store:
    """저장된 기준선. 못 읽으면 빈 것으로 시작한다 — 그러면 이번 세션에서 다시 모은다."""
    target = path or DEFAULT_PATH
    try:
        return Store.model_validate_json(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return Store()
    except (OSError, ValueError) as exc:
        log.warning("drowsy_baseline.load_failed", path=str(target), error=str(exc))
        return Store()


def save(store: Store, path: Path | None = None) -> None:
    target = path or DEFAULT_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(store.model_dump_json(indent=2), encoding="utf-8")


def merge(saved: Baseline, session: dict[str, list[float]]) -> dict[str, tuple[float, float]]:
    """누적분과 이번 세션을 합쳐 (평균, 표준편차) 를 만든다.

    자세 채널만 다르게 다룬다. 카메라 각도가 조금만 바뀌어도 pitch 의 절대값이
    통째로 움직이는데, 그 평균을 지난 주행에서 가져오면 고개를 안 숙였는데도
    숙인 것으로 읽힌다. 평균은 이번 세션 것을 쓰고 표준편차만 빌려 온다.
    """
    combined = Baseline(sessions=saved.sessions, channels=dict(saved.channels))
    for key, values in session.items():
        for value in values:
            combined.add(key, value)

    stats = combined.as_stats()
    for key in POSE_CHANNELS & session.keys():
        if key not in stats or not session[key]:
            continue
        fresh = sum(session[key]) / len(session[key])
        stats[key] = (fresh, stats[key][1])
    return stats
