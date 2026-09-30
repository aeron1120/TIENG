"""SQI 합성 (CLAUDE.md §6.2, §6.3).

여러 품질 성분(각각 0~1)을 confidence 하나로 합친다. 가중 기하평균인 이유는
산술평균이 "한 성분이 최악인데 나머지가 좋아서 통과" 를 허용하기 때문이다.
기하평균은 한 성분이라도 0 에 가까우면 전체가 0 이 되므로 그 사고를 구조적으로
막는다 — 값을 지어내지 않으려면(§0-4) 게이트가 이렇게 생겨야 한다.

성분과 가중치는 부르는 쪽이 정한다. 광류(§6.2)와 지평선(§6.3)이 보는 성분이
서로 달라서고, 여기에 상수로 박으면 §14 의 "임계값 하드코딩" 이 된다.
"""

from __future__ import annotations

import math
from collections.abc import Mapping


def clip(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def combine(scores: Mapping[str, float], weights: Mapping[str, float]) -> float:
    """가중 기하평균.

    scores 에 없는 키는 '측정 불가' 로 보고 가중치 합에서도 뺀다. 기본값 0.5 를
    채우면 '해당 없음' 과 '품질이 그저 그럼' 이 같아져서, 잴 수 없는 성분 때문에
    confidence 가 깎인다.
    """
    numerator = 0.0
    denominator = 0.0
    for key, weight in weights.items():
        if key not in scores:
            continue
        numerator += weight * math.log(max(clip(scores[key]), 1e-6))
        denominator += weight
    return math.exp(numerator / denominator) if denominator > 0 else 0.0
