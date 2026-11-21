import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The sandbox preview is served from a different host than the dev server.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  optimizeDeps: { exclude: ['pyodide'] },
});
