import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 Vite(5173)가 화면을, 서버(3000)가 API·소켓을 담당한다.
// 운영에서는 서버가 web/dist를 그대로 서빙하므로 프록시가 필요 없다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
