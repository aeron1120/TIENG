"""보호자 메일 알림 (SMTP).

**보낸 메일은 되돌릴 수 없다.** 이 파일의 설계는 전부 거기서 나온다.

- 자격증명이 없으면 start() 에서 실패한다. registry 가 실패로 잡고 정책은
  "액추에이터가 없다"로 보고 near_miss 만 남긴다. 설정을 안 한 상태에서 조용히
  메일이 나가는 일은 없다.
- mode 가 live 가 아니면 실제로 보내지 않고 로그만 남긴다 (actuators/base.py 규칙).
  데모 중에 진짜 메일이 나가는 사고를 막는다.
- 자격증명은 환경변수로만 받는다. config 에 적으면 저장소에 들어간다.

      TFV_SMTP_USER       보내는 Gmail 주소
      TFV_SMTP_PASSWORD   앱 비밀번호 (계정 비밀번호가 아니다)
      TFV_GUARDIAN_EMAIL  받는 사람. 쉼표로 여러 명

README §1 은 "전체가 LAN 안에서 동작해야 한다"고 못박았다. 보호자는 집 밖에
있으므로 L4 알림만 예외다. 측정·판단·개입 루프는 전부 LAN 안에 남고, 인터넷이
끊기면 이 액추에이터만 실패한다 — 나머지는 그대로 돈다.
"""

from __future__ import annotations

import asyncio
import os
import smtplib
from email.message import EmailMessage

import structlog

from actuators.base import Actuator
from api.schemas import Mode

log = structlog.get_logger(__name__)

ENV_USER = "TFV_SMTP_USER"
ENV_PASSWORD = "TFV_SMTP_PASSWORD"
ENV_TO = "TFV_GUARDIAN_EMAIL"


class EmailNotifier(Actuator):
    def __init__(
        self,
        id: str,
        mode: Mode,
        *,
        host: str = "smtp.gmail.com",
        port: int = 587,
        timeout_s: float = 15.0,
    ) -> None:
        super().__init__(id, mode)
        self.host = host
        self.port = port
        self.timeout_s = timeout_s
        self._user = ""
        self._password = ""
        self._to: list[str] = []

    async def start(self) -> None:
        self._user = os.environ.get(ENV_USER, "").strip()
        self._password = os.environ.get(ENV_PASSWORD, "").strip()
        self._to = [a.strip() for a in os.environ.get(ENV_TO, "").split(",") if a.strip()]

        if self.mode != "live":
            # 시뮬레이션에서는 자격증명이 없어도 올라온다. 어차피 안 보낸다.
            log.info("email.simulated", actuator=self.id)
            return

        missing = [
            name
            for name, value in ((ENV_USER, self._user), (ENV_PASSWORD, self._password),
                                (ENV_TO, self._to))
            if not value
        ]
        if missing:
            # 여기서 죽는 게 맞다. 반쯤 설정된 채로 올라오면 정작 보내야 할 때 실패한다.
            raise RuntimeError(f"환경변수가 없다: {', '.join(missing)}")

        log.info("email.ready", actuator=self.id, host=self.host, to=len(self._to))

    async def stop(self) -> None:
        """보낸 메일은 되돌릴 수 없으므로 원상복구할 것이 없다."""
        self._password = ""

    async def notify(self, subject: str, body: str) -> None:
        if self.mode != "live":
            log.info("email.skipped", actuator=self.id, mode=self.mode, subject=subject)
            return
        # smtplib 는 전부 블로킹이다. 1Hz 루프와 같은 이벤트 루프라 executor 로 뺀다.
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._send, subject, body)
        log.info("email.sent", actuator=self.id, to=len(self._to), subject=subject)

    # --- 바깥 세계 경계 ------------------------------------------------------ #

    def _send(self, subject: str, body: str) -> None:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = self._user
        message["To"] = ", ".join(self._to)
        message.set_content(body)

        with smtplib.SMTP(self.host, self.port, timeout=self.timeout_s) as smtp:
            smtp.starttls()
            smtp.login(self._user, self._password)
            smtp.send_message(message)
