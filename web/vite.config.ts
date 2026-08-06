import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 브라우저는 vite 서버 하나만 보고, /api 와 /ws 는 FastAPI로 넘긴다.
// 덕분에 CORS 설정이 필요 없고 배포 시 동일 출처 구성과도 모양이 같다.
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
