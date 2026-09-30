import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pages와 로컬 검증이 같은 API를 쓰게 한다. 개발 서버(expo start)는 영향을 받지 않는다.
const result = spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL || 'https://rider-guard-api.onrender.com',
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
