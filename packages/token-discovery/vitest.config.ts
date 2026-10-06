import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@soltrader/risk-engine': path.resolve(packageDirectory, '../risk-engine/src/index.ts'),
    },
  },
});
