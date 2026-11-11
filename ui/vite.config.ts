import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const daemon = 'http://127.0.0.1:7420';

/**
 * `/takeover/:token` is a client-side route, so only the API side of takeover
 * (`/api/v1/takeover/*`, HTTP and WebSocket) is proxied to the daemon.
 */
export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    fs: { allow: [repo] },
    proxy: {
      '/api': { target: daemon, ws: true },
      '/auth': { target: daemon },
      '/mcp': { target: daemon },
      '/hooks': { target: daemon },
      '/healthz': { target: daemon },
    },
  },
});
