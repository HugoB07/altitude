import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { E2E_DATABASE, adminUrl, loadEnv, migrateUrl } from './database.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

/**
 * A fresh database for every run.
 *
 * Recreated rather than emptied: the schema is under migration, and a run that
 * started from whatever the last one left would eventually pass against a shape
 * no fresh install has. Dropping it also means the journey can assume it is the
 * only person who has ever signed up.
 */
export default async function globalSetup() {
  loadEnv();

  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    // Sessions left open by a previous run would block the drop.
    await admin.unsafe(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${E2E_DATABASE}' AND pid <> pg_backend_pid()`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${E2E_DATABASE}`);
    await admin.unsafe(`CREATE DATABASE ${E2E_DATABASE}`);

    // The same grants docker/initdb gives the development database. Repeated
    // rather than shared because initdb only ever runs for the first database
    // on a fresh volume, and this one is created long afterwards.
    await admin.unsafe(`
      GRANT CONNECT ON DATABASE ${E2E_DATABASE} TO altitude_app, altitude_migrate;
      GRANT CREATE ON DATABASE ${E2E_DATABASE} TO altitude_migrate;`);
  } finally {
    await admin.end();
  }

  const owner = postgres(adminUrl().replace('/postgres', `/${E2E_DATABASE}`), {
    max: 1,
    onnotice: () => {},
  });
  try {
    for (const extension of ['ltree', 'pgcrypto', 'btree_gist', 'pg_trgm', 'unaccent']) {
      await owner.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    }
    // altitude_migrate owns the schema, so every table a migration creates
    // belongs to it and later migrations can ALTER them.
    await owner.unsafe(`
      ALTER SCHEMA public OWNER TO altitude_migrate;
      GRANT USAGE ON SCHEMA public TO altitude_app;
      GRANT USAGE, CREATE ON SCHEMA public TO altitude_migrate;`);
  } finally {
    await owner.end();
  }

  // The migration files themselves, in order, split on the marker drizzle-kit
  // writes. The same loop the database tests use, for the same reason: the
  // migrations are the definition of the schema, and running anything else here
  // would test a shape no deployment has.
  const migrator = postgres(migrateUrl(), { max: 1, onnotice: () => {} });
  try {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const contents = await readFile(join(MIGRATIONS, file), 'utf8');
      for (const statement of contents.split('--> statement-breakpoint')) {
        if (statement.trim() !== '') await migrator.unsafe(statement);
      }
    }
    console.log(`e2e: ${E2E_DATABASE} rebuilt from ${files.length} migrations`);
  } finally {
    await migrator.end();
  }
}
