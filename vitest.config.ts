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
    // End-to-end suites run alone (pnpm test:e2e).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.e2e.test.ts'],
  },
});
