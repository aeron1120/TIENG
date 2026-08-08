"""mock 끼리 조명 상태를 공유하는 자리.

실제 방에서는 조도계가 전구 불빛을 직접 재므로 이런 배선이 필요 없다. 하드웨어가
오기 전에 "불을 켜면 조도가 올라가고 confidence 가 회복된다"는 L1 루프를 돌려
보려면, 액추에이터가 켠 사실이 조도에 반영돼야 해서 둔다.

simulated 모드의 액추에이터만 여기에 쓰고, live 모드는 손대지 않는다.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_bonus_lux = 0.0


def set_room_light(on: bool, lux_gain: float) -> None:
    """simulated 조명이 방에 더하는 조도. 끄면 0 으로 돌아간다."""
    global _bonus_lux
    with _lock:
        _bonus_lux = lux_gain if on else 0.0


def room_light_bonus_lux() -> float:
    with _lock:
        return _bonus_lux


def reset() -> None:
    """테스트가 서로 오염되지 않게 하는 용도."""
    set_room_light(False, 0.0)
