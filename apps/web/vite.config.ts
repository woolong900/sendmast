import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBase = env.VITE_API_BASE_URL ?? 'http://localhost:4000';
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiBase, changeOrigin: true },
        // Trailing slash is REQUIRED. Vite's proxy keys are prefix matches, so
        // '/t' (no slash) also captures '/templates/...' SPA routes — refresh
        // on /templates/<id>/edit then hits the API and returns a JSON 404.
        '/t/': { target: apiBase, changeOrigin: true },
        '/health': { target: apiBase, changeOrigin: true },
        // Public-bucket assets (uploaded via /api/uploads/image) are served
        // through this path so URLs are port-less. Easy Email's canvas inline-
        // style parser breaks on URLs containing `:port`, which would hide
        // Section/Wrapper background images. The API returns paths like
        // `/sendmast-public/<key>` when S3_PUBLIC_BASE_URL is configured to
        // match; we rewrite them to MinIO here.
        '/sendmast-public': {
          target: env.S3_ENDPOINT ?? 'http://localhost:9000',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    // Force-prebundle the workspace shared package. Without this, Vite serves
    // dist/index.js straight from /@fs/.../packages/shared/dist as ESM, but
    // shared compiles to CommonJS — so any *value* import (e.g. SYSTEM_TAGS,
    // not just type imports) fails with "does not provide an export named ...".
    // Letting esbuild prebundle it converts CJS named exports to real ESM ones.
    optimizeDeps: {
      include: ['@sendmast/shared'],
    },
  };
});
