"""하드웨어 없이 돌리는 전체 자체 검증.

    python scripts/selftest.py

카메라도 센서도 없이, 신호처리 코어부터 개입 정책까지 한 번에 확인한다. 파이에
올리기 전과 시연 직전에 이걸 먼저 돌려 볼 것.

실제 하드웨어가 붙었는지는 여기서 못 본다. 그건 scripts/hwcheck.py 가 한다.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import structlog

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import force_utf8  # noqa: E402

force_utf8()

from actuators.tuya_plug import TuyaPlug  # noqa: E402
from api.schemas import Metric, Snapshot, server_now  # noqa: E402
from core import quality, sim_room, thresholds  # noqa: E402
from core.adapters.thermal_mlx90640 import ThermalRespiration  # noqa: E402
from core.policy.l1_light import L1Light  # noqa: E402
from core.policy.runner import PolicyRunner  # noqa: E402
from core.pulse import HrEstimator  # noqa: E402
from core.registry import Registry  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FS = 30.0

_results: list[dict[str, object]] = []
_section = ""
_quiet = False


def section(title: str) -> None:
    """섹션 제목. --json 일 때는 결과를 묶는 이름으로만 쓰인다."""
    global _section
    _section = title
    if not _quiet:
        print(f"\n{title}")


def check(name: str, ok: bool, detail: str = "") -> None:
    _results.append({"section": _section, "name": name, "ok": bool(ok), "detail": str(detail)})
    if not _quiet:
        print(f"  {'OK' if ok else 'XX'}  {name:<38} {detail}")


# --------------------------------------------------------------------------- #


def synthetic_rgb(bpm: float, seconds: float = 14.0) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(0)
    t = np.arange(0.0, seconds, 1.0 / FS)
    pulse = np.sin(2 * np.pi * (bpm / 60.0) * t)
    rgb = (
        np.array([0.60, 0.50, 0.42])[None, :]
        + np.outer(pulse, [0.010, 0.030, 0.015])
        + (0.015 * np.sin(2 * np.pi * 0.08 * t))[:, None]
        + rng.normal(0, 0.004, size=(len(t), 3))
    )
    return t, rgb


def test_signal_core() -> None:
    section("[1] rPPG 신호 코어 — 합성 신호로 BPM 복원")
    gate = thresholds.load(ROOT / "config" / "thresholds.yaml").confidence_min
    for bpm in (55, 72, 90, 120, 150):
        # 추정기를 매번 새로 만든다. 하나를 돌려 쓰면 55 를 받아들인 직후 72 가
        # 들어오고, jump guard 는 그걸 밀리초 만에 17bpm 뛴 것으로 본다 — 여기서
        # 재려는 것은 신호 코어의 복원 정확도지 궤적 연속성이 아니다.
        estimator = HrEstimator(source="rppg", mode="live", gate=gate)
        t, rgb = synthetic_rgb(bpm)
        m = estimator.estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)
        err = abs(float(m.value) - bpm) if m.value is not None else float("inf")
        check(f"{bpm} bpm 복원 (오차 3 이내)", err <= 3.0, f"추정 {m.value} / 오차 {err:.1f}")


def test_quality_gating() -> None:
    section("[2] 품질 게이팅 — 못 믿을 신호는 값을 내지 않는다")
    estimator = HrEstimator(source="rppg", mode="live", gate=0.4)
    t, rgb = synthetic_rgb(72)

    clean = estimator.estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)
    dark = estimator.estimate(t, rgb, jitter_norm=1.0, skin_ratio=0.05, brightness=10.0)
    lost = quality.score(
        peak_snr_db=20.0, band_energy_ratio=0.9, skin_ratio=0.02, brightness=100.0, jitter_norm=0.0
    )

    check("정상 신호는 값을 낸다", clean.state == "ok" and clean.value is not None)
    check("열악한 신호는 보류", dark.state == "low_quality" and dark.value is None)
    check("얼굴을 놓치면 confidence 0", lost.confidence == 0.0, lost.hold_reason())


def thermal_run(rpm: float, seconds: float) -> Metric:
    """합성 열화상 프레임을 seconds 만큼 먹인 뒤 한 번 추정한다.

    어댑터가 자기 카메라를 열게 둔다 — 합성 시계와 캡처 주기를 맞추는 것도
    어댑터 몫이라, 여기서 카메라를 따로 만들면 그 배선을 안 태운다.
    """
    adapter = ThermalRespiration(
        id="thermal", mode="simulated", nostril_roi=[13, 9, 6, 5], synthetic_rpm=rpm
    )
    adapter._gate = thresholds.load(ROOT / "config" / "thresholds.yaml").confidence_min
    camera = adapter._open_camera()
    for _ in range(int(seconds * adapter.refresh_hz)):
        adapter._ingest(camera.read())
    return adapter._estimate(
        np.asarray(adapter._times, dtype=np.float64),
        np.asarray(adapter._temps, dtype=np.float64),
        adapter._roi_pixels,
        adapter._delta_t,
    )


def test_thermal_rr() -> None:
    section("[3] 열화상 호흡 — 합성 프레임으로 RR 복원 (카메라 불필요)")
    for rpm in (10, 15, 22):
        m = thermal_run(rpm, seconds=30.0)
        err = abs(float(m.value) - rpm) if m.value is not None else float("inf")
        check(f"{rpm} rpm 복원 (오차 2 이내)", err <= 2.0, f"추정 {m.value} / 오차 {err:.1f}")

    # RR 최소 창은 20초다. 그 구간과 "온도 대비가 없어서 못 낸다"가 둘 다
    # low_quality 라, progress 없이는 화면에서 구분이 안 된다 (README §2).
    warming = thermal_run(15, seconds=10.0)
    check(
        "창 채우는 중에는 보류",
        warming.value is None and warming.state == "low_quality",
        f"state={warming.state}",
    )
    check(
        "기다리면 되는지를 진행률로 알린다",
        warming.progress is not None and 0.0 < warming.progress < 1.0,
        f"progress={warming.progress}",
    )


def test_thresholds() -> None:
    section("[4] 임계값 — 코드가 아니라 thresholds.yaml 이 정한다")
    active = thresholds.load(ROOT / "config" / "thresholds.yaml")
    check("프로파일 로드", bool(active.profile), f"profile={active.profile}")
    check("L1 임계값 존재", "lux_min" in active.policy("l1_light"), str(active.policy("l1_light")))

    day = datetime.now().astimezone().replace(hour=12, minute=0)
    night = day.replace(hour=1)
    check("야간 판정 (낮)", not active.night_mode.covers(day))
    check("야간 판정 (새벽)", active.night_mode.covers(night))


def snapshot(confidence: float, lux: float, at: datetime) -> Snapshot:
    return Snapshot(
        device_id="selftest", ts=at, interventions=[],
        metrics=[
            Metric(key="hr", value=70.0, unit="bpm", source="mock",
                   mode="simulated", state="ok", confidence=confidence, ts=at),
            Metric(key="lux", value=lux, unit="lx", source="mock",
                   mode="simulated", state="ok", confidence=None, ts=at),
        ],
    )


async def test_l1_policy() -> None:
    section("[5] L1 조명 개입 — 어두울 때만, 야간은 제외")
    sim_room.reset()
    active = thresholds.load(ROOT / "config" / "thresholds.yaml")
    switch = TuyaPlug(id="room_light", mode="simulated")
    await switch.start()
    policy = L1Light(active, {"room_light": switch})

    noon = datetime.now().astimezone().replace(hour=12, minute=0, second=0, microsecond=0)
    night = noon.replace(hour=1)

    check("어둡고 신뢰도 낮음 → 발화", policy.should_fire(snapshot(0.2, 20.0, noon)))
    check("밝으면 참는다", not policy.should_fire(snapshot(0.2, 300.0, noon)))
    check("신뢰도 충분하면 참는다", not policy.should_fire(snapshot(0.9, 20.0, noon)))
    fired_at_night = policy.should_fire(snapshot(0.2, 20.0, night))
    check("야간에는 참는다", not fired_at_night and policy.near_miss, policy.last_reason)


async def test_l1_loop() -> None:
    section("[6] L1 폐루프 — 개입하면 효과가 측정된다")
    sim_room.reset()
    active = thresholds.load(ROOT / "config" / "thresholds.yaml")
    switch = TuyaPlug(id="room_light", mode="simulated", simulated_lux_gain=120.0)
    await switch.start()
    policy = L1Light(active, {"room_light": switch})
    policy.evaluate_after_s = 0
    runner = PolicyRunner([policy])

    noon = datetime.now().astimezone().replace(hour=12, minute=0, second=0, microsecond=0)
    await runner.tick(snapshot(0.2, 20.0, noon))
    check("개입 발화", len(runner.recent) == 1,
          runner.recent[0].trigger if runner.recent else "")
    check("조명 켜짐", switch.is_on)

    await runner.tick(snapshot(0.85, 150.0, noon + timedelta(seconds=20)))
    event = runner.recent[0]
    improved = (
        event.after is not None
        and event.after["hr_confidence"] > event.before["hr_confidence"]
    )
    check("전후 비교 기록", improved, f"{event.before} -> {event.after}")


async def test_mock_pipeline() -> None:
    section("[7] mock 설정 — 하드웨어 0개로 전체 파이프라인")
    sim_room.reset()
    registry = Registry.from_yaml(ROOT / "config" / "device.mock.yaml")
    await registry.start()
    metrics = await registry.read_all(server_now())
    keys = [m.key for m in metrics]
    modes = {m.mode for m in metrics}
    policies = [p.level for p in registry.policies]
    actuators = list(registry.actuators)
    await registry.stop()

    check("지표가 나온다", len(metrics) >= 5, ", ".join(keys))
    check("전부 합성값", modes == {"simulated"}, str(modes))
    check("액추에이터 로드", actuators == ["room_light", "guardian_email"], str(actuators))
    check("정책 로드", policies == ["L1", "L4"], str(policies))


async def main() -> int:
    global _quiet
    parser = argparse.ArgumentParser(description="하드웨어 없이 도는 자체 검증")
    parser.add_argument("--json", action="store_true", help="결과를 JSON 으로 (웹 화면용)")
    args = parser.parse_args()
    _quiet = args.json

    if _quiet:
        # 로그가 stdout 으로 나오면 JSON 을 오염시킨다. 로그는 원래 stderr 가 맞다.
        structlog.configure(logger_factory=structlog.PrintLoggerFactory(file=sys.stderr))

    if not _quiet:
        print("TouchFree Vitals — 자체 검증 (하드웨어 불필요)")
    test_signal_core()
    test_quality_gating()
    test_thermal_rr()
    test_thresholds()
    await test_l1_policy()
    await test_l1_loop()
    await test_mock_pipeline()

    failed = [r for r in _results if not r["ok"]]
    if _quiet:
        print(
            json.dumps(
                {
                    "total": len(_results),
                    "passed": len(_results) - len(failed),
                    "checks": _results,
                },
                ensure_ascii=False,
            )
        )
    else:
        print(f"\n{'-' * 60}")
        print(f"{len(_results) - len(failed)}/{len(_results)} 통과")
        for r in failed:
            print(f"  실패: {r['name']}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
