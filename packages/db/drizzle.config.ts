import { defineConfig } from 'drizzle-kit';
import { requireEnv } from '@altitude/shared/env';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    // A getter, not a value: only the commands that actually connect read it.
    // `generate` and `check` diff against the snapshot in meta/ and never open a
    // connection, so requiring the variable eagerly would stop them working
    // offline — which is half the point of keeping the snapshot.
    //
    // MIGRATE_DATABASE_URL rather than DATABASE_URL, because migrations create
    // tables and policies. The application role cannot do either: it holds only
    // DML rights and is subject to row-level security. Two variables keep the
    // privileged role from being reachable by the application by accident.
    //
    // No fallback. A default would silently point migrations at whatever the
    // literal named — a developer's laptop, most likely — and succeed.
    get url(): string {
      return requireEnv(
        'MIGRATE_DATABASE_URL',
        'Migrations need the role that bypasses row-level security, not the application role.',
      );
    },
  },
  // Everything drizzle-kit cannot express — the balance trigger, RLS policies,
  // the ltree GiST index, the ownership overlap constraint — lives in
  // hand-written migrations alongside the generated ones.
  verbose: true,
  strict: true,
});
