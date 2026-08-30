import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireEnv } from '@altitude/shared/env';

/**
 * The database the end-to-end run works in.
 *
 * A database of its own on the same server, not the development one. The
 * journey signs someone up and creates a household, and a test that leaves that
 * behind in the database you are developing against is a test people stop
 * running.
 *
 * Its name is fixed, which is what lets playwright.config.ts state the
 * connection strings up front: Playwright reads its config before it starts the
 * web server, so an address discovered during setup would arrive too late for
 * the server that needs it.
 */
export const E2E_DATABASE = 'altitude_e2e';

/** Loads the workspace env file, the same way drizzle-kit does. */
export function loadEnv() {
  for (const file of ['../../../.env.local', '../../../.env']) {
    const path = fileURLToPath(new URL(file, import.meta.url));
    if (existsSync(path)) {
      process.loadEnvFile(path);
      break;
    }
  }
}

/**
 * Points a configured connection string at another database on the same server.
 *
 * Derived from what is already configured rather than assembled from a fresh
 * set of variables: whoever moved the port or changed the password did it once,
 * and the end-to-end run should follow rather than ask again.
 *
 * No fallback anywhere here. A default would quietly connect somewhere nobody
 * chose, which on a command whose next step is DROP DATABASE is the worst place
 * for a guess.
 */
function urlFor(variable, database, hint) {
  const url = new URL(requireEnv(variable, hint));
  url.pathname = `/${database}`;
  return url.toString();
}

/** The application role: subject to row-level security, per ADR-0007. */
export function appUrl(database = E2E_DATABASE) {
  return urlFor('DATABASE_URL', database, 'The application role, altitude_app.');
}

/** The migration role: may create tables, bypasses row-level security. */
export function migrateUrl(database = E2E_DATABASE) {
  return urlFor('MIGRATE_DATABASE_URL', database, 'The role that may create tables.');
}

/**
 * A connection that may CREATE and DROP a database.
 *
 * Neither application role can, by design, so this is the one thing the run
 * needs that the normal configuration does not already provide. It connects to
 * `postgres` - the database every server has - because the one being created
 * may not exist yet.
 */
export function adminUrl() {
  const url = new URL(
    requireEnv(
      'E2E_ADMIN_DATABASE_URL',
      'A role that may CREATE DATABASE. See .env.example; the development server has one.',
    ),
  );
  url.pathname = '/postgres';
  return url.toString();
}
