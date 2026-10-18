import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // Per-server dep cache for parallel e2e (playwright.config.ts sets it per worker); dev keeps the default.
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Test output churns constantly during an e2e run (traces, videos, homeserver logs/DBs); watching it cost each
      // dev server ~45% of a core in stat calls, multiplied by one dev server per Playwright worker (issue #2).
      ignored: ['**/e2e/results/**', '**/e2e/tmp/**', '**/e2e/demo-mobile/**', '**/playwright-report/**', '**/test-results/**', '**/homeserver/**', '**/seed/**', '**/android/**', '**/ios/**', '**/docs/**'],
    },
  },
  optimizeDeps: {
    // Phase 5: the crypto engine resolves its .wasm with `new URL('./pkg/x.wasm', import.meta.url)`; esbuild's
    // dep pre-bundling would inline the module into .vite/deps and break that URL. Excluded, Vite serves the
    // package's own ESM entry and the .wasm from node_modules in dev; Rollup emits it as an asset in the build.
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
