import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const API_PORT = Number(process.env.PNPFORGE_PORT ?? 3717);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    // Game data changes constantly and must never be watched (on Windows the
    // watcher's file handles also block moving deleted games to the trash).
    watch: { ignored: ['**/data/**', '**/.shots/**', '**/samples/**'] },
    proxy: {
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
});
