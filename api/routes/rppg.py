"""브라우저 카메라 표본 수신.

화면을 연 기기의 카메라로 심박을 잰다. 서버에 카메라가 없는 배포(Render)에서도
값이 나오게 하려는 것이고, 파이 앞에 없는 사람이 자기 기기로 재는 경로이기도 하다.

올라오는 것은 영상이 아니라 얼굴 ROI 의 평균 RGB 다. 브라우저가 프레임에서 세
숫자를 뽑고 그 시계열만 보낸다 — 30fps 로 초당 4개짜리 숫자 묶음 서른 개, 1KB 남짓이다.
영상이 기기 밖으로 나가지 않는다는 규칙(README §1 비목표)이 서버가 인터넷 저편에
있어도 그대로 성립한다.

이 방향(브라우저 -> 서버)은 api/ws.py 가 지키는 "프론트는 받기만 한다"의 예외처럼
보이지만 그렇지 않다. 여기서 브라우저는 카메라 자리를 대신하는 센서다. 무엇을
심박으로 볼지 판단하는 것은 여전히 서버고 (core/pulse.py), 화면은 그 답을 받아
그릴 뿐이다.

WebSocket 이 아니라 POST 인 이유: /api 는 Cloudflare Pages 함수가 이미 그대로
넘긴다 (functions/api/[[path]].js). 새 경로를 열려고 프록시를 하나 더 만들 이유가 없다.
"""

from __future__ import annotations

import asyncio
from typing import Annotated

import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from api.auth import COOKIE
from api.feeds import MAX_BATCH, Feeds
from api.schemas import Metric

log = structlog.get_logger(__name__)

router = APIRouter()

# (t, r, g, b). t 는 브라우저의 단조 시계(초), 나머지는 ROI 평균 채널값이다.
# 단위를 강요하지 않는다 — POS 는 채널별 평균으로 나눠 쓰므로 0~1 이든 0~255 든 같다.
Sample = tuple[float, float, float, float]

# 0~1 로 들어와야 하는 품질 성분. 범위를 벗어난 값이 confidence 를 밀어 올리지
# 못하게 여기서 자른다.
Unit = Annotated[float, Field(ge=0.0, le=1.0)]


class Batch(BaseModel):
    """한 번에 올리는 표본 묶음.

    품질 성분을 브라우저가 계산해 보내는 것은 그것이 픽셀을 봐야 나오는 값이기
    때문이다 (피부 비율·밝기·ROI 흔들림). 서버에는 프레임이 없어 다시 잴 수 없다.

    그래서 이 값들은 믿고 쓰는 수밖에 없고, 조작하면 자기 화면의 신뢰도가 부풀 뿐
    남에게는 영향이 없다 — 결과가 그 세션에게만 가기 때문이다 (api/ws.py).
    """

    samples: list[Sample] = Field(min_length=1, max_length=MAX_BATCH)
    jitter_norm: Unit = 0.0
    skin_ratio: Unit = 0.0
    brightness: float = Field(default=0.0, ge=0.0, le=255.0)


class Reading(BaseModel):
    """방금 표본으로 낸 값. 화면은 이걸 기다리지 않고 WebSocket 으로 받아도 되지만,
    카메라를 켠 직후에는 이 응답이 먼저 와서 진행률이 바로 돈다."""

    metric: Metric


@router.post("/api/rppg/samples", response_model=Reading)
async def push(request: Request, body: Batch) -> Reading:
    token = request.cookies.get(COOKIE)
    if not token:
        # 세션이 없으면 어느 창에 돌려줄지 정할 수 없다. 게이트(api/main.py)가 이미
        # 막지만, 토큰이 열쇠라는 것을 여기서도 분명히 해 둔다.
        raise HTTPException(401, "세션이 없다")

    feeds: Feeds = request.app.state.personal
    feed = feeds.feed(token)
    # scipy 는 블로킹이다. 1Hz 샘플 루프가 같은 이벤트 루프에서 돈다 (api/main.py).
    metric = await asyncio.to_thread(
        feed.push, body.samples, body.jitter_norm, body.skin_ratio, body.brightness
    )
    return Reading(metric=metric)


@router.delete("/api/rppg/samples")
async def stop(request: Request) -> dict[str, bool]:
    """카메라를 껐다. 창을 버려 마지막 값이 화면에 남지 않게 한다.

    안 불러도 STALE_AFTER_S 뒤에 저절로 내려간다. 이 경로는 그 몇 초를 기다리지
    않게 하는 것뿐이다.
    """
    token = request.cookies.get(COOKIE)
    if token:
        feeds: Feeds = request.app.state.personal
        feeds.drop(token)
    return {"ok": True}
