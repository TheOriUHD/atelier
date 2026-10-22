/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset paths so the same build loads from app:// (desktop) and from the server's base URL (web).
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2023',
    // The artifact runtime is a second page, served from its own origin (see apps/*/artifact protocol/route).
    rollupOptions: { input: { main: 'index.html', artifact: 'artifact-runtime/index.html', inlineVisual: 'inline-visual.html' } },
  },
  server: {
    port: 5199,
    strictPort: true,
    // Web dev: the API server runs on 7340 (pnpm dev:web); the desktop app talks to its backend over IPC instead.
    proxy: { '/api': { target: 'http://127.0.0.1:7340', ws: true } },
    // The sandboxed artifact frame has an opaque ("null") origin, and module scripts are CORS requests.
    cors: { origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, 'null'] },
  },
  test: { environment: 'happy-dom', setupFiles: ['./src/test/setup.ts'] },
});
