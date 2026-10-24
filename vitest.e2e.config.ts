import path from 'node:path';

import { defineConfig } from 'vitest/config';

/** End-to-end suite (pnpm test:e2e): sequential, local development database only (the tests refuse anything else). */
export default defineConfig({
  resolve: {
    alias: {
      '@soltrader/risk-engine': path.resolve(__dirname, 'packages/risk-engine/src/index.ts'),
      '@soltrader/monitoring': path.resolve(__dirname, 'packages/monitoring/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.e2e.test.ts', '**/*.stress.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    fileParallelism: false,
    testTimeout: 1_200_000,
    hookTimeout: 600_000,
  },
});
