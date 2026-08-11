"""화면에서 바꾼 기기 설정. device.yaml 위에 덮는다.

device.yaml 을 되쓰지 않는 이유는 주석이다. 그 파일의 주석이 사실상 설정 문서라
(window_s 가 왜 12초인지, nostril_roi 를 어떻게 실측하는지, tuya 값을 채우기 전에는
L1 이 왜 보류되는지) yaml 로 다시 쓰면 통째로 날아간다. git 추적 파일이기도 해서,
기기마다 화면에서 고친 자국이 쌓이면 다음 pull 이 충돌한다.

그래서 손으로 적는 기본값은 device.yaml 에 그대로 두고, 화면에서 바꾼 것만 여기에
남긴다. state/ 에 두는 것은 layout.json 과 같은 이유다 — 설정이 아니라 기기별
사용 흔적이다.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import structlog
from pydantic import BaseModel

log = structlog.get_logger(__name__)

DEFAULT_PATH = Path("state/overrides.json")

# core/adapters/rppg.py 가 받는 값과 같아야 한다. 여기서 한 번 더 좁히는 이유는
# 화면에서 온 문자열이 그대로 어댑터 생성자로 들어가기 때문이다.
CameraBackend = Literal["opencv", "picamera2"]


class Overrides(BaseModel):
    """None 은 "덮지 않는다" — device.yaml 에 적힌 값을 그대로 쓴다."""

    camera_backend: CameraBackend | None = None


def load(path: Path | None = None) -> Overrides:
    """저장된 값. 없거나 깨졌으면 아무것도 덮지 않는다.

    오버라이드 파일 하나 때문에 서버가 안 뜨면 곤란하다. 못 읽으면 device.yaml
    그대로 올라간다 — 화면에서 다시 고르면 된다.
    """
    target = path or DEFAULT_PATH  # 기본값은 호출 시점에 읽는다 (테스트에서 갈아 끼운다)
    try:
        return Overrides.model_validate_json(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return Overrides()
    except (OSError, ValueError) as exc:
        log.warning("overrides.load_failed", path=str(target), error=str(exc))
        return Overrides()


def save(overrides: Overrides, path: Path | None = None) -> None:
    target = path or DEFAULT_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(overrides.model_dump_json(indent=2), encoding="utf-8")
