import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const clientRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3001', ws: true },
      '/api': { target: 'http://127.0.0.1:3001' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
