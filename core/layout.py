"""실시간 화면의 블록 배치.

브라우저 저장소를 쓰지 않으므로 (README §10) 어떤 지표를 크게 볼지, 나머지를 어떤
순서로 쌓을지도 서버가 들고 있는다. localStorage 에 넣으면 같은 계정을 다른
브라우저로 열었을 때 배치가 달라진다.

저장은 계정별이다 (api/auth.py). 처음에는 기기별 파일 하나였는데, 그건 방 하나에
태블릿 하나를 전제로 한 것이라 화면이 공개 주소로 열리면서 성립하지 않게 됐다 —
한 사람이 카메라를 크게 보면 다른 모든 사람 화면이 같이 바뀌었다.

지표 키는 센서 구성에 따라 달라지므로 화이트리스트로 막지 않는다. 대신 길이를
제한한다 — 여기가 클라이언트 입력을 그대로 저장소에 쓰는 경로 중 하나다.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

MAX_BLOCKS = 32  # 한 화면에 지표가 이보다 많을 일은 없다

Key = Annotated[str, StringConstraints(min_length=1, max_length=64)]


class Layout(BaseModel):
    """크게 볼 지표 하나와 보조 블록 순서.

    order 에 없는 지표는 화면이 뒤에 붙이고, order 에 있지만 지금 없는 지표는
    건너뛴다. 그래야 센서를 꽂았다 뺐다 해도 배치가 깨지지 않는다.

    hero 는 지표 키가 아닐 수도 있다 — 카메라가 그 자리에 서면 "camera" 가 들어간다
    (web/src/pages/Kiosk.tsx).
    """

    hero: Key = "hr"
    order: Annotated[list[Key], Field(max_length=MAX_BLOCKS)] = Field(default_factory=list)
