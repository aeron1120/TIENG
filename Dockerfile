# 하드웨어 없이 도는 데모 이미지.
#
# 화면과 API 를 한 이미지에 담는다. api/main.py 가 web/dist 를 같은 포트로 서빙하므로
# (docs/hardware.md §4) 서비스가 하나면 프록시도 CORS 도 필요 없다.
#
# 실제 기기는 이걸 쓰지 않는다. 카메라·I2C·GPIO 는 컨테이너 밖 하드웨어라 파이에서
# 직접 돌려야 하고, 그쪽 배포는 deploy/tfv.service 다.

FROM node:20-slim AS web
WORKDIR /web
# 소스보다 먼저 복사해서 의존성 레이어를 캐시한다. 화면만 고칠 때 npm 을 다시 돌지 않는다.
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build


FROM python:3.13-slim AS runtime
WORKDIR /app

# -e 로 설치한다. pyproject 의 packages 에 actuators 가 없어서 일반 설치로는
# tuya_plug / notify_email 을 못 찾는다. 소스 트리에서 그대로 도는 편이 안전하다.
COPY pyproject.toml ./
COPY core/ ./core/
COPY api/ ./api/
COPY actuators/ ./actuators/
COPY config/ ./config/
RUN pip install --no-cache-dir -e .

COPY --from=web /web/dist ./web/dist

# mock 구성이 개입 기록을 쓰고, 계정 DB 는 state/ 에 생긴다. 둘 다 컨테이너와 함께
# 사라진다 — 계정을 남기려면 Supabase 로 옮겨야 한다.
RUN mkdir -p logs state

# 데모라 하드웨어가 없다. mock 구성이 합성 센서로 파이프라인 전체를 돌린다.
ENV DEVICE_CONFIG=config/device.mock.yaml \
    PYTHONUNBUFFERED=1 \
    PORT=8000

EXPOSE 8000
# Render 는 $PORT 를 주입한다. 기본값은 로컬에서 그냥 돌려 볼 때 쓴다.
CMD ["sh", "-c", "exec uvicorn api.main:app --host 0.0.0.0 --port ${PORT}"]
