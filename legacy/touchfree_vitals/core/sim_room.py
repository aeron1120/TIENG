"""mock 들이 공유하는 가상의 방.

**개발용이다.** live 어댑터/액추에이터는 여기를 쓰지 않는다. 실제 방에서는
조도계가 전구 불빛을 직접 재고, 카메라가 그 밝기에서 실제로 신호를 얻는다.

하드웨어가 오기 전에 L1 루프("어두워짐 → 신뢰도 하락 → 조명 개입 → 신뢰도 회복")를
끝까지 돌려 보려면, 액추에이터가 켠 사실이 조도에 반영되고 그 조도가 다시
신뢰도에 반영돼야 한다. 그 연결을 여기 한 곳에 모아 둔다.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_light_gain = 0.0
_lux = 0.0


def set_light(on: bool, lux_gain: float) -> None:
    """simulated 조명이 방에 더하는 조도. 끄면 0 으로 돌아간다."""
    global _light_gain
    with _lock:
        _light_gain = lux_gain if on else 0.0


def light_bonus_lux() -> float:
    with _lock:
        return _light_gain


def set_lux(value: float) -> None:
    """조도계 mock 이 매 틱 기록한다. 다른 mock 이 이 값을 참조한다."""
    global _lux
    with _lock:
        _lux = value


def lux() -> float:
    with _lock:
        return _lux


def reset() -> None:
    """테스트가 서로 오염되지 않게 하는 용도."""
    global _light_gain, _lux
    with _lock:
        _light_gain = 0.0
        _lux = 0.0
