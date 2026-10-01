import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pages와 로컬 검증이 같은 API를 쓰게 한다. 개발 서버(expo start)는 영향을 받지 않는다.
// --clear: EXPO_PUBLIC_* 값은 변환 단계에서 코드에 박히는데, Pages가 빌드 캐시를 재사용하면 파일이 안 바뀐 곳에
// 예전 값(빈 카카오 키 등)이 남는다. 매번 캐시를 비운다.
const result = spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL || 'https://rider-guard-api-ejwy.onrender.com',
    // 카카오 지도 JavaScript 키 — 원래 번들에 공개되는 값이고 카카오 콘솔에 등록한 도메인에서만 동작한다.
    // 빌드 환경변수가 있으면 그것이 우선.
    EXPO_PUBLIC_KAKAO_MAP_KEY: process.env.EXPO_PUBLIC_KAKAO_MAP_KEY || '75516dadc5fc637c6fbfbfe4e7c519f2',
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
