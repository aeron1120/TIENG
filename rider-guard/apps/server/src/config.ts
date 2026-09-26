export type Config = {
  env: 'development' | 'production' | 'test';
  port: number;
  dbPath: string;
  /** SMS 에 넣는 위치 링크의 기준 주소. 휴대폰에서 열려야 하므로 운영에서는 공개 도메인이어야 한다. */
  publicBaseUrl: string;
  /** 취소 카운트다운 (4.3: 30~60초) */
  countdownSeconds: number;
  /** 비상연락처 1순위 → 2순위 문자 사이 간격. 앞 순위가 링크에서 '확인'을 누르면 다음 순위는 보내지 않는다. */
  contactStaggerSeconds: number;
  /** 운행 종료를 잊었을 때 자동 종료까지 (4.1.1) */
  sessionMaxHours: number;
  otpTtlSeconds: number;
  otpResendSeconds: number;
  opsToken: string;
  centerPhone: string;
  /** 119 문자 신고 자동 발송. 로드맵 Phase 2 까지는 꺼 두고 상담원이 직접 신고한다 (10장). */
  enable119Sms: boolean;
};

const DEV_OPS_TOKEN = 'dev-ops-token';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const port = int(env.PORT, 4000);
  const config: Config = {
    env: mode,
    port,
    dbPath: env.DB_PATH ?? './data/rider-guard.db',
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    countdownSeconds: int(env.COUNTDOWN_SECONDS, 30),
    contactStaggerSeconds: int(env.CONTACT_STAGGER_SECONDS, 60),
    sessionMaxHours: int(env.SESSION_MAX_HOURS, 12),
    otpTtlSeconds: 300,
    otpResendSeconds: 30,
    opsToken: env.OPS_TOKEN ?? DEV_OPS_TOKEN,
    centerPhone: env.CENTER_PHONE ?? '0000',
    enable119Sms: env.ENABLE_119_SMS === 'true',
  };

  if (config.countdownSeconds < 30 || config.countdownSeconds > 60) {
    throw new Error(`COUNTDOWN_SECONDS 는 30~60 사이여야 합니다 (설계문서 4.3). 현재: ${config.countdownSeconds}`);
  }
  if (mode === 'production') {
    if (config.opsToken === DEV_OPS_TOKEN || config.opsToken.length < 24) throw new Error('운영 환경에서는 24자 이상의 OPS_TOKEN 이 필요합니다.');
    if (!env.PUBLIC_BASE_URL) throw new Error('운영 환경에서는 PUBLIC_BASE_URL 이 필요합니다.');
  }
  return config;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`정수가 아닌 설정값: ${value}`);
  return n;
}
