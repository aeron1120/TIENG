"""계약 산출물 생성 (모듈 ↔ 화면 결합 지점).

프론트와 모듈을 따로 만들기로 했으므로, 둘을 잇는 것은 사람의 기억이 아니라 파일
두 개여야 한다.

  api/openapi.json           엔드포인트와 응답 모양
  web/fixtures/snapshot.json 백엔드 없이 화면을 띄울 때 쓰는 표본

둘 다 **실제 pydantic 모델에서 생성한다.** 손으로 적으면 core/schemas.py 가 바뀐
뒤에도 프론트는 옛 모양을 믿고 그리게 되고, 그 어긋남은 화면이 깨질 때까지 안 보인다.

    python tools/export_contract.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.console import force_utf8  # noqa: E402
from core.schemas import Snapshot  # noqa: E402


def sample_snapshot() -> Snapshot:
    """화면이 다뤄야 하는 상태를 한 장에 모은 표본.

    지표를 비워 두지 않는 이유는 프론트가 `—` 경로를 그려 봐야 하기 때문이다
    (§13-11 검증 항목). 값이 None 인 칸이 0 으로 그려지면 그 자리에서 잡아야 한다.

    이것은 픽스처지 측정값이 아니다. mode 를 "simulated" 로 두어 화면이 실측처럼
    보여 주지 않게 한다 (§0-4).
    """
    return Snapshot.model_validate({
        "device_id": "pi5-01",
        "session_id": "2026-09-18T22-14-03_pi5-01",
        "t": 12.4,
        "mode": "simulated",
        "fused": None,
        "indicators": [
            {"key": "peak_g", "value": 1.12, "unit": "g", "state": "ok", "sqi": None, "t": 12.4},
            {"key": "bank_angle", "value": 0.41, "unit": "rad", "state": "ok",
             "sqi": 0.88, "t": 12.4},
            {"key": "speed_drop", "value": None, "unit": "m/s", "state": "low_quality",
             "sqi": 0.12, "t": 12.4},
            {"key": "flow_loss", "value": None, "unit": "s", "state": "no_adapter",
             "sqi": None, "t": 12.4},
        ],
        "recent_events": [],
        "health": {
            "imu_sim.dropped": 0.0,
            "imu_sim.errors": 0.0,
            "imu_sim.queued": 40.0,
            "imu.samples": 20.0,
            "tick.count": 620.0,
            "tick.max_late_ms": 1.8,
        },
    })


def main() -> None:
    force_utf8()

    from api.server import app  # lifespan 을 돌리지 않고 스키마만 읽는다

    openapi = ROOT / "api" / "openapi.json"
    openapi.write_text(
        json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    fixture = ROOT / "web" / "fixtures" / "snapshot.json"
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_text(
        json.dumps(sample_snapshot().model_dump(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"계약  {openapi.relative_to(ROOT)}")
    print(f"표본  {fixture.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
