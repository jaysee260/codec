import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
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
