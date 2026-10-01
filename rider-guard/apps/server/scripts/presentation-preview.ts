/** One local command builds and serves the integrated demo and receiving monitor together. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { systemClock } from '../src/lib.ts';
import { consoleLogger, consoleProviders } from '../src/providers.ts';

const port = 4001;
const base = `http://localhost:${port}`;
const riderDir = fileURLToPath(new URL('../../rider/', import.meta.url));
const build = spawnSync(process.execPath, ['scripts/build-web.mjs'], {
  cwd: riderDir, stdio: 'inherit', env: { ...process.env, EXPO_PUBLIC_API_URL: base },
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

// Explicit local config: this preview never opens a configured production DB or provider.
const config = loadConfig({ NODE_ENV: 'development', DEMO_MODE: 'true', PUSH_PROVIDER: 'console', DETECTION_ENABLED: 'false', PORT: String(port), PUBLIC_BASE_URL: base, DATABASE_URL: 'file:./data/presentation-preview.db' });
const db = await Db.open(config.databaseUrl);
const app = createApp({ db, config, clock: systemClock, providers: consoleProviders(consoleLogger), log: consoleLogger });
const root = '../rider/dist';
app.get('/_expo/*', serveStatic({ root }));
app.get('/assets/*', serveStatic({ root }));
app.get('/favicon.ico', serveStatic({ root }));
const entry = serveStatic({ root, rewriteRequestPath: () => '/index.html' });
app.get('/', entry);
app.get('/demo', entry);
app.get('/demo/*', entry);

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  consoleLogger.info(`통합 시연: ${base}/demo`);
  consoleLogger.info(`운영 모니터: ${base}/ops/presentation`);
});
const close = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', close);
process.on('SIGTERM', close);
