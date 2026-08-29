import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Testcontainers pulls and boots a real PostgreSQL 17, which the default
    // 5 s timeout cannot cover on a cold image.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // The schema is declarations, exercised by the database tests rather than
      // by unit tests; counting it would measure nothing and hide the packages
      // where coverage is a real signal.
      exclude: ['packages/db/src/**'],
      // packages/core carries the ledger invariant and the valuation engine.
      // A gap in its coverage is a gap in the guarantee (plan §15.1).
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
