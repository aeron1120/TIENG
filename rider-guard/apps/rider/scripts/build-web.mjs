import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pages와 로컬 검증이 같은 API를 쓰게 한다. 개발 서버(expo start)는 영향을 받지 않는다.
const result = spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL || 'https://rider-guard-api.onrender.com',
    // 카카오 지도 JavaScript 키 — 원래 번들에 공개되는 값이고 카카오 콘솔에 등록한 도메인에서만 동작한다.
    // Pages 대시보드 변수가 빌드에 들어오지 않아(wrangler.jsonc 사용) 기본값으로 둔다. 환경변수가 있으면 그것이 우선.
    EXPO_PUBLIC_KAKAO_MAP_KEY: process.env.EXPO_PUBLIC_KAKAO_MAP_KEY || '75516dadc5fc637c6fbfbfe4e7c519f2',
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
