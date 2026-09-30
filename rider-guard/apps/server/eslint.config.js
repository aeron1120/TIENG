// 타입 정보를 쓰는 검사만 켠다 — DB 호출이 전부 비동기라, await 를 빠뜨린 줄은 tsc 로는 안 잡힌다.
// 트랜잭션 안에서 await 를 빠뜨리면 커밋 뒤에 쿼리가 돌아 조용히 어긋난다.
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': [
      'error',
      // node:test 의 test() 는 Promise 를 돌려주지만 러너가 기다린다
      { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] },
    ],
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
  },
});
