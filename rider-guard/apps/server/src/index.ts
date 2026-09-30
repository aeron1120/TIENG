import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { Db } from './db.ts';
import { systemClock } from './lib.ts';
import { consoleLogger, consoleProviders, expoPush } from './providers.ts';
import { DEMO_RIDER_EMAIL, DEMO_RIDER_ID, seedDemo } from './services/detections.ts';
import { recoverOutbox, startScheduler } from './services/scheduler.ts';

const config = loadConfig();
const log = consoleLogger;
const push = config.pushProvider === 'expo' ? expoPush(config.expoAccessToken) : undefined;
const db = await Db.open(config.databaseUrl, config.databaseAuthToken);
const ctx: AppContext = { db, config, clock: systemClock, providers: consoleProviders(log, push), log };

await recoverOutbox(ctx);
if (config.demoMode) {
  await seedDemo(ctx);
  log.info(`데모 모드 — 문자·119·배차를 밖으로 보내지 않아요. 데모 라이더 ${DEMO_RIDER_ID}${config.demoRiderPassword ? ` (앱 로그인 ${DEMO_RIDER_EMAIL})` : ''}`);
}
if (!config.ingestToken) log.warn('INGEST_TOKEN 없음 — 지표 라우터 판정(/v1/detections)을 받지 않아요');
const stopScheduler = startScheduler(ctx);
const server = serve({ fetch: createApp(ctx).fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  log.info(`Rider Guard API — http://localhost:${info.port} (${config.env})`);
  log.info(`운영 모니터(읽기 전용) — http://localhost:${info.port}/ops  토큰: ${config.env === 'production' ? '(OPS_TOKEN)' : config.opsToken}`);
  if (config.oauth.kakao && !config.kakaoAdminKey) log.warn('KAKAO_ADMIN_KEY 없음 — 탈퇴 회원의 카카오 연결 끊기가 키를 넣을 때까지 쌓여요');
});

function shutdown() {
  stopScheduler();
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
