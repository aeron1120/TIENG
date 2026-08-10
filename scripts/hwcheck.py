"""하드웨어 연결 점검.

    python scripts/hwcheck.py                  # config/device.yaml 기준
    python scripts/hwcheck.py --config other.yaml

센서를 꽂은 직후 제일 먼저 돌린다. 어댑터를 하나씩 실제로 start() → read() 해 보고,
실패하면 원인과 다음에 확인할 것을 알려 준다. 서버를 띄우고 카드가 회색인 걸 보며
추측하는 것보다 여기서 보는 편이 빠르다.

알고리즘 검증은 하지 않는다. 그건 scripts/selftest.py 가 한다.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import force_utf8  # noqa: E402

force_utf8()

from actuators.base import Actuator  # noqa: E402
from api.schemas import server_now  # noqa: E402
from core.adapters.base import SensorAdapter  # noqa: E402
from core.registry import (  # noqa: E402
    ActuatorEntry,
    AdapterEntry,
    DeviceConfig,
    Registry,
    _implementation,
)

# 실패했을 때 다음에 확인할 것. 추측을 줄이려고 붙인다.
HINTS = {
    "core.adapters.env_bme680": [
        "sudo raspi-config → Interface Options → I2C 활성화",
        "i2cdetect -y 1 에 0x76 (또는 0x77) 이 보이는지",
        "0x77 이면 config 의 i2c_addr 을 0x77 로",
    ],
    "core.adapters.env_bh1750": [
        "i2cdetect -y 1 에 0x23 (또는 0x5c) 이 보이는지",
        "ADDR 핀이 GND 면 0x23, VCC 면 0x5c",
    ],
    "core.adapters.pir": [
        "pin 번호는 BCM 기준이다 (물리 핀 번호 아님)",
        "PIR 은 전원 후 30~60초 워밍업이 필요하다",
        "Pi 5 는 lgpio 가 필요하다: pip install lgpio",
    ],
    "core.adapters.rppg": [
        "CSI 리본 카메라면 backend 를 picamera2 로 (opencv 로는 안 열린다)",
        "rpicam-hello --list-cameras 에 카메라가 보이는지",
        "USB 웹캠이면 backend 는 opencv, v4l2-ctl --list-devices 로 인덱스 확인",
    ],
    "actuators.tuya_plug": [
        "python -m tinytuya wizard 로 device_id / local_key 를 뽑는다",
        "플러그와 파이가 같은 네트워크(대역)에 있어야 한다",
        "version 은 보통 3.3 또는 3.4",
    ],
}


def hint(module: str) -> None:
    for line in HINTS.get(module, []):
        print(f"        - {line}")


async def check_adapter(entry: AdapterEntry) -> bool:
    label = f"{entry.id:<14} ({entry.mode})"
    if entry.mode == "unavailable":
        print(f"  --  {label}  config 에서 꺼 둠")
        return True

    try:
        cls = _implementation(importlib.import_module(entry.module), SensorAdapter)  # type: ignore[type-abstract]
        adapter = cls(id=entry.id, mode=entry.mode, **entry.params)
    except Exception as exc:
        print(f"  XX  {label}  로드 실패: {exc}")
        hint(entry.module)
        return False

    try:
        await adapter.start()
    except Exception as exc:
        print(f"  XX  {label}  start 실패: {exc}")
        hint(entry.module)
        return False

    try:
        metrics = await adapter.read()
        shown = ", ".join(
            f"{m.key}={'—' if m.value is None else m.value}{m.unit or ''}" for m in metrics
        )
        print(f"  OK  {label}  {shown}")
        return True
    except Exception as exc:
        print(f"  XX  {label}  read 실패: {exc}")
        hint(entry.module)
        return False
    finally:
        try:
            await adapter.stop()
        except Exception:
            pass


async def check_actuator(entry: ActuatorEntry) -> bool:
    label = f"{entry.id:<14} ({entry.mode})"
    try:
        cls = _implementation(importlib.import_module(entry.module), Actuator)  # type: ignore[type-abstract]
        actuator = cls(id=entry.id, mode=entry.mode, **entry.params)
        await actuator.start()
    except Exception as exc:
        print(f"  XX  {label}  연결 실패: {exc}")
        hint(entry.module)
        return False

    try:
        # 실제로 껐다 켜 본다. 눈으로 확인하는 게 이 점검의 목적이다.
        print(f"  ..  {label}  2초간 켜 본다")
        await actuator.turn_on()  # type: ignore[attr-defined]
        await asyncio.sleep(2)
        await actuator.turn_off()  # type: ignore[attr-defined]
        print(f"  OK  {label}  켜짐/꺼짐 확인")
        return True
    except Exception as exc:
        print(f"  XX  {label}  제어 실패: {exc}")
        hint(entry.module)
        return False
    finally:
        try:
            await actuator.stop()
        except Exception:
            pass


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config/device.yaml")
    parser.add_argument("--skip-actuators", action="store_true", help="전구를 건드리지 않는다")
    args = parser.parse_args()

    path = Path(args.config)
    config = DeviceConfig.model_validate(Registry.from_yaml(path).config.model_dump())
    print(f"하드웨어 점검 — {path}  (device_id={config.device_id})\n")

    print("[센서]")
    results = [await check_adapter(e) for e in config.adapters]

    if not args.skip_actuators:
        print("\n[액추에이터]")
        results += [await check_actuator(e) for e in config.actuators]

    print("\n[정책]")
    registry = Registry(config)
    registry.actuators = {}
    registry._build_policies()
    for policy in registry.policies:
        print(f"  OK  {policy.level:<14} cooldown {policy.cooldown_s}s")
    if not registry.policies:
        print("  XX  로드된 정책이 없다 — thresholds.yaml 과 policies 설정 확인")
        results.append(False)

    ok = sum(results)
    print(f"\n{'-' * 56}\n{ok}/{len(results)} 정상")
    if ok < len(results):
        print("\n실패한 항목은 위 힌트를 확인할 것. 하드웨어가 아직 없으면 정상이다.")
        print("알고리즘만 먼저 보려면: python scripts/selftest.py")
    # 하드웨어 미연결은 '실패'가 아니라 상태 보고다. 종료 코드는 항상 0.
    now = server_now()
    print(f"점검 시각 {now.astimezone():%Y-%m-%d %H:%M:%S}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
