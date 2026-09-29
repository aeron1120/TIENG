import type { SocialProvider } from '@rider-guard/contract';

import { DEFAULT_THRESHOLDS, type Thresholds } from './services/detection.ts';
import type { ProviderCredentials } from './services/social.ts';

export type Config = {
  env: 'development' | 'production' | 'test';
  port: number;
  /**
   * 저장소 주소 (libSQL). 로컬 개발은 파일 file:./data/rider-guard-v2.db, 테스트는 :memory:,
   * 클라우드는 libsql://<db>.turso.io (이때 DATABASE_AUTH_TOKEN 도 필요하다).
   */
  databaseUrl: string;
  /** 클라우드(Turso) 인증 토큰. 로컬 파일·:memory: 에서는 비워 둔다. */
  databaseAuthToken: string | undefined;
  /** SMS 에 넣는 위치 링크의 기준 주소. 휴대폰에서 열려야 하므로 운영에서는 공개 도메인이어야 한다. */
  publicBaseUrl: string;
  /** 취소 카운트다운 (4.3: 30~60초) */
  countdownSeconds: number;
  /** 비상연락처 1순위 → 2순위 문자 사이 간격. 앞 순위가 링크에서 '확인'을 누르면 다음 순위는 보내지 않는다. */
  contactStaggerSeconds: number;
  /** 운행 종료를 잊었을 때 자동 종료까지 (4.1.1) */
  sessionMaxHours: number;
  opsToken: string;
  centerPhone: string;
  /** 119 문자 신고 자동 발송. 로드맵 Phase 2 까지는 꺼 두고 상담원이 직접 신고한다 (10장). */
  enable119Sms: boolean;
  /**
   * 지표 판정으로 사고를 여는가. 꺼져 있으면 판정만 기록한다 — 로드맵 Phase 1(데이터 수집, 경보 없음).
   * 개발 서버는 켜고, 운영은 DETECTION_ENABLED=true 로 명시해야 켜진다.
   */
  detectionEnabled: boolean;
  thresholds: Thresholds;
  /** 라이더 앱 푸시. expo = Expo 푸시 서비스로 실제 발송, console = 서버 로그에만 */
  pushProvider: 'expo' | 'console';
  /** EAS 대시보드에서 푸시 보안을 켰을 때만 필요 */
  expoAccessToken: string | undefined;
  /**
   * SNS 로그인 키. 둘 다 있어야 그 로그인 버튼이 앱에 보인다. 콜백 주소는 PUBLIC_BASE_URL/auth/oauth/<제공자>/callback.
   * 카카오: REST API 키 + 클라이언트 시크릿 / 네이버: Client ID + Secret / 구글: 웹 애플리케이션 OAuth 클라이언트 ID + 보안 비밀
   */
  oauth: Partial<Record<SocialProvider, ProviderCredentials>>;
  /** 카카오 Admin 키 — 탈퇴한 회원의 카카오 연결 끊기(카카오 정책상 필수)에 쓴다. 없으면 끊기 요청이 쌓여 있다가 키를 넣으면 처리된다. */
  kakaoAdminKey: string | undefined;
  /** 앱 딥링크 스킴 (app.json scheme) — SNS 로그인 뒤 돌아갈 주소 */
  appScheme: string;
};

export const DEV_OPS_TOKEN = 'dev-ops-token';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const port = int(env.PORT, 4000);
  const config: Config = {
    env: mode,
    port,
    databaseUrl: env.DATABASE_URL || 'file:./data/rider-guard-v2.db',
    databaseAuthToken: env.DATABASE_AUTH_TOKEN || undefined,
    // Render 는 서비스 주소를 RENDER_EXTERNAL_URL 로 넣어 준다
    publicBaseUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    countdownSeconds: int(env.COUNTDOWN_SECONDS, 30),
    contactStaggerSeconds: int(env.CONTACT_STAGGER_SECONDS, 60),
    sessionMaxHours: int(env.SESSION_MAX_HOURS, 12),
    opsToken: env.OPS_TOKEN ?? DEV_OPS_TOKEN,
    centerPhone: env.CENTER_PHONE ?? '0000',
    enable119Sms: env.ENABLE_119_SMS === 'true',
    detectionEnabled: env.DETECTION_ENABLED ? env.DETECTION_ENABLED === 'true' : mode !== 'production',
    thresholds: {
      deltaVMin: num(env.DV_MIN, DEFAULT_THRESHOLDS.deltaVMin),
      tiltMinDeg: num(env.TILT_MIN_DEG, DEFAULT_THRESHOLDS.tiltMinDeg),
      stillAccelVarMax: num(env.STILL_ACCEL_VAR_MAX, DEFAULT_THRESHOLDS.stillAccelVarMax),
      stillSpeedMax: num(env.STILL_SPEED_MAX, DEFAULT_THRESHOLDS.stillSpeedMax),
    },
    pushProvider: env.PUSH_PROVIDER === 'console' ? 'console' : 'expo',
    expoAccessToken: env.EXPO_ACCESS_TOKEN || undefined,
    oauth: {
      kakao: pair(env.KAKAO_REST_API_KEY, env.KAKAO_CLIENT_SECRET),
      naver: pair(env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET),
      google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    },
    kakaoAdminKey: env.KAKAO_ADMIN_KEY || undefined,
    appScheme: env.APP_SCHEME || 'riderguard',
  };

  if (config.countdownSeconds < 30 || config.countdownSeconds > 60) {
    throw new Error(`COUNTDOWN_SECONDS 는 30~60 사이여야 합니다 (설계문서 4.3). 현재: ${config.countdownSeconds}`);
  }
  if (mode === 'production') {
    if (config.opsToken === DEV_OPS_TOKEN || config.opsToken.length < 24) throw new Error('운영 환경에서는 24자 이상의 OPS_TOKEN 이 필요합니다.');
    if (!env.PUBLIC_BASE_URL && !env.RENDER_EXTERNAL_URL) throw new Error('운영 환경에서는 PUBLIC_BASE_URL 이 필요합니다.');
  }
  return config;
}

function pair(clientId: string | undefined, clientSecret: string | undefined): ProviderCredentials | undefined {
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`숫자가 아닌 설정값: ${value}`);
  return n;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`정수가 아닌 설정값: ${value}`);
  return n;
}
