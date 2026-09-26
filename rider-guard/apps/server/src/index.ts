import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { Db } from './db.ts';
import { systemClock } from './lib.ts';
import { consoleLogger, consoleProviders } from './providers.ts';
import { recoverOutbox, startScheduler } from './services/scheduler.ts';

const config = loadConfig();
const log = consoleLogger;
const ctx: AppContext = { db: new Db(config.dbPath), config, clock: systemClock, providers: consoleProviders(log), log };

recoverOutbox(ctx);
const stopScheduler = startScheduler(ctx);
const server = serve({ fetch: createApp(ctx).fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  log.info(`Rider Guard API — http://localhost:${info.port} (${config.env})`);
  log.info(`관제 콘솔 — http://localhost:${info.port}/ops  토큰: ${config.env === 'production' ? '(OPS_TOKEN)' : config.opsToken}`);
  if (!config.enable119Sms) log.info('119 문자 자동 신고 꺼짐 — 상담원이 신고문을 보고 직접 신고 (로드맵 Phase 2)');
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
