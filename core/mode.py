"""운전 모드. 이 기기가 지금 무엇을 재는 데 집중하는가.

카메라는 하나뿐이고 Pi 의 CPU 도 한정돼 있다. rPPG 는 매 프레임 얼굴을 찾고 피부
픽셀을 고르고, 졸음 쪽은 매 프레임 YuNet 을 돌린다. 둘 다 켜 두면 프레임률이
갈리는데, 졸음은 눈깜빡임(100~400ms)을 봐야 해서 프레임률이 곧 정확도다.

그래서 무엇을 쉬게 할지는 config 가 정한다 (README §0-5). 어댑터 항목에 modes 를
적으면 그 모드에서만 돈다.

    - id: rppg
      modes: [vitals]     # 졸음 모드에서는 쉰다

modes 를 안 적으면 항상 돈다. 카메라처럼 누가 쓰든 있어야 하는 것이 그렇다.

배치(core/layout.py)와 같은 자리에 같은 방식으로 저장한다 — 기기 설정이 아니라
사용 흔적이라 state/ 에 둔다.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import structlog
from pydantic import BaseModel

log = structlog.get_logger(__name__)

DEFAULT_PATH = Path("state/mode.json")

Mode = Literal["vitals", "drowsy"]
MODES: tuple[Mode, ...] = ("vitals", "drowsy")


class ModeState(BaseModel):
    """vitals = 생체 신호 중심, drowsy = 졸음 방지 중심."""

    mode: Mode = "vitals"


def load(path: Path | None = None) -> ModeState:
    """저장된 모드. 못 읽으면 기본값이다 — 파일 하나 때문에 화면이 안 뜨면 곤란하다."""
    target = path or DEFAULT_PATH
    try:
        return ModeState.model_validate_json(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return ModeState()
    except (OSError, ValueError) as exc:
        log.warning("mode.load_failed", path=str(target), error=str(exc))
        return ModeState()


def save(state: ModeState, path: Path | None = None) -> None:
    target = path or DEFAULT_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(state.model_dump_json(indent=2), encoding="utf-8")
