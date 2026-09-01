import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `apps/web/test` holds guards about the application's own boundaries,
    // not component tests. `e2e` is Playwright's and is not matched here.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Testcontainers pulls and boots a real PostgreSQL 17, which the default
    // 5 s timeout cannot cover on a cold image.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Excluded because the unit run does not execute them, not because they
      // are untested: both are covered by the database suite (pnpm test:db).
      // Counting code a run never reaches measures the run, not the code, and
      // would dilute the packages where this number is a real signal.
      //
      //   packages/db/src      schema declarations
      //   core/src/services    needs a live transaction handle
      exclude: ['packages/db/src/**', 'packages/core/src/services/**'],
      // packages/core carries the ledger invariant and the valuation engine.
      // A gap in its coverage is a gap in the guarantee (plan §15.1).
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
