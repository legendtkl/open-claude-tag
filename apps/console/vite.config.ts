import { defineConfig } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.CONSOLE_PORT ?? 5173),
    proxy: {
      '/admin': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/health': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    // CONSOLE_HOST=0.0.0.0 exposes the preview server beyond loopback for
    // server-mode deployments (front with TLS in production).
    host: process.env.CONSOLE_HOST ?? '127.0.0.1',
    port: Number(process.env.CONSOLE_PORT ?? 4173),
    proxy: {
      '/admin': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/health': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
});
