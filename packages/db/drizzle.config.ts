import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://altitude:altitude@localhost:55432/altitude',
  },
  // Everything drizzle-kit cannot express — the balance trigger, RLS policies,
  // the ltree GiST index, the ownership overlap constraint — lives in
  // hand-written migrations alongside the generated ones.
  verbose: true,
  strict: true,
});
