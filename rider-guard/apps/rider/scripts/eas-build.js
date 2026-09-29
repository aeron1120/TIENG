// EAS 빌드를 이 앱 폴더만 올려서 돌린다.
// 이 PC 는 홈 폴더(C:\Users\packm)가 git 루트라, 그냥 돌리면 EAS 가 홈 폴더 전체를 훑다가 실패한다.
// git 을 쓰지 않는 모드(EAS_NO_VCS)로 올릴 범위를 이 폴더로 못박는다. 제외 목록은 .easignore.
//   npm run build:android            개발 빌드 (폰에 바로 설치하는 APK)
//   npm run build:android -- --no-wait
const { spawnSync } = require('node:child_process');

// npm run 은 항상 앱 폴더(package.json 위치)에서 실행된다.
const root = process.cwd();
const args = ['eas-cli', 'build', '--profile', 'development', '--platform', 'android', ...process.argv.slice(2)];
const result = spawnSync('npx', args, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, EAS_NO_VCS: '1', EAS_PROJECT_ROOT: root },
});
process.exit(result.status ?? 1);
