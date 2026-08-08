r"""스크립트 출력 인코딩 고정.

Windows 에서 출력을 파일이나 파이프로 넘기면 파이썬이 로캘 코드페이지(한글
Windows 는 CP949)로 인코딩한다. 이 프로젝트가 쓰는 em dash(—) 같은 문자는
CP949 에 없어서 그 순간 UnicodeEncodeError 로 스크립트가 죽는다.

콘솔에 그냥 찍을 때는 파이썬이 WriteConsoleW 를 써서 멀쩡하다. 그래서 화면으로
볼 때는 멀쩡하다가 **로그로 남기려는 순간** 실패한다 — 발견이 늦어 더 나쁘다.

    python scripts\selftest.py            정상
    python scripts\selftest.py > log.txt  UnicodeEncodeError
"""

from __future__ import annotations

import sys


def force_utf8() -> None:
    """stdout/stderr 를 UTF-8 로 고정한다. 콘솔에서는 이미 UTF-8 이라 무해하다."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:  # 이미 감싸인 스트림이면 건드리지 않는다
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            # 인코딩을 못 바꾸는 스트림이라도 스크립트가 죽을 이유는 없다.
            pass
