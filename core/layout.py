"""실시간 화면의 블록 배치.

브라우저 저장소를 쓰지 않으므로 (README §10) 어떤 지표를 크게 볼지, 나머지를 어떤
순서로 쌓을지도 서버가 들고 있는다. 키오스크는 한 번 세워 두고 계속 켜 두는
화면이라 새로고침마다 배치가 초기화되면 매번 다시 고르게 되고, localStorage 에
넣으면 같은 기기를 다른 브라우저로 열었을 때 배치가 달라진다.

지표 키는 센서 구성에 따라 달라지므로 화이트리스트로 막지 않는다. 대신 길이를
제한한다 — 여기가 클라이언트 입력을 그대로 디스크에 쓰는 유일한 곳이다.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import structlog
from pydantic import BaseModel, Field, StringConstraints

log = structlog.get_logger(__name__)

DEFAULT_PATH = Path("state/layout.json")
MAX_BLOCKS = 32  # 한 화면에 지표가 이보다 많을 일은 없다

Key = Annotated[str, StringConstraints(min_length=1, max_length=64)]


class Layout(BaseModel):
    """크게 볼 지표 하나와 보조 블록 순서.

    order 에 없는 지표는 화면이 뒤에 붙이고, order 에 있지만 지금 없는 지표는
    건너뛴다. 그래야 센서를 꽂았다 뺐다 해도 배치가 깨지지 않는다.
    """

    hero: Key = "hr"
    order: Annotated[list[Key], Field(max_length=MAX_BLOCKS)] = Field(default_factory=list)


def load(path: Path | None = None) -> Layout:
    """저장된 배치. 파일이 없거나 깨졌으면 기본 배치로 돌아간다.

    배치 파일 하나 때문에 화면이 안 뜨면 곤란하다. 못 읽으면 그냥 기본값이다.
    """
    target = path or DEFAULT_PATH  # 기본값은 호출 시점에 읽는다 (테스트에서 갈아 끼운다)
    try:
        return Layout.model_validate_json(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return Layout()
    except (OSError, ValueError) as exc:
        log.warning("layout.load_failed", path=str(target), error=str(exc))
        return Layout()


def save(layout: Layout, path: Path | None = None) -> None:
    target = path or DEFAULT_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(layout.model_dump_json(indent=2), encoding="utf-8")
