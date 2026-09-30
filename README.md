# TIENG · Rider Guard

현재 앱과 API는 [`rider-guard/`](rider-guard/README.md)에서 개발합니다.

- 웹 앱: https://tieng.pages.dev/ — Cloudflare Pages, Expo / React Native Web
- API: https://rider-guard-api.onrender.com — Render, Node.js 24 / Hono
- DB: libSQL / Turso 구성. 로컬에서는 SQLite 파일을 사용합니다.
- 로그인: API 서버가 Google·카카오·네이버 OAuth를 직접 처리합니다. Rider Guard는 Supabase Auth를 사용하지 않습니다.

배포 및 Google OAuth 설정은 [배포 안내](rider-guard/docs/deployment.md)를 참고하세요.

## 저장소

```text
rider-guard/                 현재 앱, API, 공유 타입, 설계 자료
legacy/moto_sensing/        이전 센싱 프로젝트, ESP32, 시뮬레이션과 루트 자료
legacy/touchfree_vitals/    이전 TouchFree Vitals (Supabase 사용 코드)
legacy/tieng_rppg/          이전 rPPG 프로젝트
```

`legacy/`는 보관용이며 현재 웹 배포에 포함하지 않습니다. 기존 센싱 프로젝트의 상대 경로는
`legacy/moto_sensing/` 안에서 유지했습니다. 로컬 데이터셋·로그·캐시와 비밀 값은 Git에 추가하지 않습니다.
