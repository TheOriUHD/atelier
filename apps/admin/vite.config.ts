/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The admin panel (deploy/admin serves dist/ as static assets in front of its /api). In development the API is the
// local `wrangler dev` of deploy/admin (deploy/admin/scripts/dev.mjs) on 8788.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023', sourcemap: false },
  server: { port: 5181, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8788' } },
  test: { environment: 'node' },
});
