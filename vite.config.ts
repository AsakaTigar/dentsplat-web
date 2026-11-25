import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this app from https://<user>.github.io/<repo>/, so every emitted URL has to be
  // relative to that subpath. With base './', import.meta.env.BASE_URL is './' at build time, which is
  // what src/data/cases.ts and App.tsx prepend to their asset fetches; in dev it stays '/'.
  base: './',
  // .dspk is our own container: served as a static file and read with fetch().arrayBuffer(),
  // so no loader is needed — but listing it keeps `vite build` from trying to inline/parse it.
  assetsInclude: ['**/*.dspk', '**/*.glb'],
  server: { port: 5177, host: true },
  preview: { port: 5177 },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    reportCompressedSize: true,
  },
});
