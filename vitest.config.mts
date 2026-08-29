import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // packages/core carries the ledger invariant and the valuation engine.
      // A gap in its coverage is a gap in the guarantee (plan §15.1).
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
