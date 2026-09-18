import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 브라우저는 vite 서버 하나만 보고, /api 와 /ws 는 FastAPI 로 넘긴다. 덕분에 CORS
// 설정이 필요 없고, 배포 시 한 포트로 합치는 구성과도 모양이 같다 (api/server.py).
//
// 백엔드가 안 떠 있어도 화면은 뜬다 — useSnapshot 이 web/fixtures/snapshot.json 으로
// 넘어간다. 프론트를 따로 만들 수 있게 하는 것이 그 폴백이다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
})
