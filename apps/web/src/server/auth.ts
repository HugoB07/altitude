import 'server-only';

import { randomUUID } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createClient, type Client } from '@altitude/db';
import { authSchema } from '@altitude/db/schema';
import { optionalEnv, requireEnv } from '@altitude/shared/env';

/**
 * Built on first use, not at import.
 *
 * `next build` loads these modules to collect route metadata. Reading secrets
 * or opening a connection at module scope would make the build require a
 * database and a production secret to produce static output - and fail with a
 * stack trace from inside the bundler rather than a sentence naming what is
 * missing.
 *
 * Deferring also keeps the failure where it belongs: the first request that
 * needs authentication, with the error from requireEnv.
 */
let cachedClient: Client | undefined;
let cachedAuth: ReturnType<typeof build> | undefined;

function dbClient(): Client {
  cachedClient ??= createClient({
    url: requireEnv('DATABASE_URL', 'The application role, altitude_app - not the migration role.'),
  });
  return cachedClient;
}

function build() {
  const baseURL = optionalEnv('ALTITUDE_BASE_URL', 'http://localhost:3000');

  return betterAuth({
    database: drizzleAdapter(dbClient().unsafe, {
      provider: 'pg',
      // Better Auth's default names collide with the domain: its `account` is
      // an OAuth credential, ours is a bank account. The mapping keeps both.
      schema: authSchema,
      // Defaults to false, which is why a failed sign-up left a user row with
      // no credential behind: the two inserts ran as separate statements, and a
      // failure on the second stranded the first. The account is then unusable
      // and unrecoverable - "user already exists" blocks trying again.
      //
      // PostgreSQL has transactions; the option exists for databases that do
      // not, and this is not one.
      transaction: true,
    }),

    secret: requireEnv('AUTH_SECRET', 'Generate with: openssl rand -base64 32'),
    baseURL,

    user: {
      // The column is display_name; Better Auth writes to `name`.
      fields: { name: 'displayName' },
    },

    emailAndPassword: {
      enabled: true,
      // Argon2id is Better Auth's default. Twelve characters, because a wealth
      // tracker reachable from the internet is worth more to an attacker than
      // the eight most guidance still suggests.
      minPasswordLength: 12,
      // No verification email until SMTP is a configured, tested path.
      // Requiring one now would lock people out of their own instance.
      requireEmailVerification: false,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // The active household lives on the session rather than the user, so two
      // browsers can sit in two households without one switching the other.
      additionalFields: {
        activeHouseholdId: { type: 'string', required: false, input: false },
      },
    },

    advanced: {
      database: {
        // Better Auth mints its own opaque string ids. Every id column in this
        // schema is `uuid`, and memberships.user_id is a foreign key onto one,
        // so its default is rejected outright by Postgres - the whole schema
        // would have to become text to accommodate it.
        generateId: () => randomUUID(),
      },
      // Self-hosted on a single origin: there is no cross-site flow to
      // accommodate, so the cookie stays strict.
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        secure: baseURL.startsWith('https://'),
      },
    },
  });
}

export function getAuth(): ReturnType<typeof build> {
  cachedAuth ??= build();
  return cachedAuth;
}

export function getAuthDbClient(): Client {
  return dbClient();
}

export type Auth = ReturnType<typeof build>;
