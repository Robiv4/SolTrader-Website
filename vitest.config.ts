import path from 'node:path';

import { defineConfig } from 'vitest/config';

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
    // The API suites hit the shared development database in parallel; allow for its latency.
    testTimeout: 15_000,
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
  },
});
