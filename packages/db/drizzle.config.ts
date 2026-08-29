import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { requireEnv } from '@altitude/shared/env';

// drizzle-kit reads no env file of its own, so without this every command would
// need the variable exported by hand. Node's own loader, so no dotenv
// dependency - and fileURLToPath rather than URL.pathname, which yields
// "/C:/..." on Windows.
//
// .env.local before .env, matching Next's precedence: the local file is the
// gitignored one holding real values.
for (const file of ['../../.env.local', '../../.env']) {
  const path = fileURLToPath(new URL(file, import.meta.url));
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    // A getter, not a value: only the commands that actually connect read it.
    // `generate` and `check` diff against the snapshot in meta/ and never open a
    // connection, so requiring the variable eagerly would stop them working
    // offline - which is half the point of keeping the snapshot.
    //
    // MIGRATE_DATABASE_URL rather than DATABASE_URL, because migrations create
    // tables and policies. The application role cannot do either: it holds only
    // DML rights and is subject to row-level security. Two variables keep the
    // privileged role from being reachable by the application by accident.
    //
    // No fallback. A default would silently point migrations at whatever the
    // literal named - a developer's laptop, most likely - and succeed.
    get url(): string {
      return requireEnv(
        'MIGRATE_DATABASE_URL',
        'Migrations need the role that bypasses row-level security, not the application role.',
      );
    },
  },
  // Everything drizzle-kit cannot express - the balance trigger, RLS policies,
  // the ltree GiST index, the ownership overlap constraint - lives in
  // hand-written migrations alongside the generated ones.
  verbose: true,
  strict: true,
});
