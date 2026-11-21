import { defineConfig } from 'vite';

// GitHub Pages serves project sites under /<repo>/, so the base is injected by
// the deploy workflow. Local dev and preview stay at the root.
const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  base,
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
