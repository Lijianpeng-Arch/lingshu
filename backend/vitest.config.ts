import path from 'node:path';
import { defineConfig } from 'vitest/config';

const projectRoot = path.resolve(__dirname, '..');

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    root: projectRoot,
    include: ['backend/src/**/*.test.ts', 'backend/scripts/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
