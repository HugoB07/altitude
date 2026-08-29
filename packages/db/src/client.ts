import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { HouseholdId, UserId } from '@altitude/shared';
import * as schema from './schema/index';

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Who a unit of work is being performed for.
 *
 * Every query against household data needs one. There is no ambient default:
 * a caller that cannot say which household it is acting for has no business
 * reading household data.
 */
export interface TenantContext {
  readonly householdId: HouseholdId;
  readonly userId?: UserId;
}

export interface ClientOptions {
  readonly url: string;
  readonly max?: number;
}

/**
 * Which database role to connect as.
 *
 * `altitude_app` — the web application and the worker, both of them. It is
 * subject to row-level security, which is the whole of the second barrier. A
 * background job that spans households iterates them and calls `withHousehold`
 * once per household: slower than one unscoped query, and it means a bug in the
 * worker cannot leak across households either. Tables with no household of
 * their own — instrument prices, FX rates — carry no policy, so this role reads
 * and writes them freely without needing an exemption.
 *
 * `altitude_migrate` — migrations, backups and maintenance only. It holds
 * BYPASSRLS, so it sees every household by design. Nothing that serves a request
 * may connect as it, and `assertTenantScopingActive` refuses to start if
 * something does.
 *
 * There is deliberately no option on this client to switch between them. The
 * choice is made once, in the connection string, by whoever deploys — not per
 * call site, where "just this once" would eventually mean everywhere.
 */

export interface Client {
  /**
   * The raw handle. Reaching household data through it skips the scoping in
   * `withHousehold`, which is why an ESLint rule forbids importing it outside
   * this package — the barrier is only a barrier if it cannot be walked around.
   */
  readonly unsafe: Database;
  readonly sql: postgres.Sql;
  close(): Promise<void>;
}

export function createClient(options: ClientOptions): Client {
  const client = postgres(options.url, {
    max: options.max ?? 10,
    // numeric and int8 arrive as strings and stay strings. postgres.js would
    // otherwise hand back a JavaScript number for some of them, silently
    // reintroducing the float this project spent ADR-0006 avoiding.
    types: {
      bigint: postgres.BigInt,
    },
    onnotice: () => {},
  });

  return {
    unsafe: drizzle(client, { schema }),
    sql: client,
    close: () => client.end(),
  };
}

/**
 * Runs a unit of work bound to one household.
 *
 * This is the first of the two barriers in ADR-0007. It opens a transaction and
 * declares the tenant on that connection, so the row-level security policies
 * added in migrations 0001 and 0002 have something to filter on.
 *
 * `SET LOCAL` is what makes this safe under a connection pool: the setting is
 * scoped to the transaction and is discarded at COMMIT or ROLLBACK, so a
 * connection returned to the pool cannot carry one household's identity into
 * the next request. A plain `SET` would do exactly that, and the leak would
 * appear only under concurrency.
 *
 * `set_config(..., true)` rather than a literal `SET LOCAL`: the value is a
 * parameter, so a crafted household id cannot become SQL.
 */
export async function withHousehold<T>(
  client: Client,
  ctx: TenantContext,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return client.unsafe.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_household', ${ctx.householdId}, true)`);
    if (ctx.userId !== undefined) {
      await tx.execute(sql`SELECT set_config('app.current_user', ${ctx.userId}, true)`);
    }
    return work(tx);
  });
}

/**
 * Runs work identified by a user but not yet bound to a household.
 *
 * Only sign-in needs this: reading which households someone belongs to is the
 * one question that cannot be asked from inside a household. Migration 0004
 * adds the policies that make it answerable — a user sees their own membership
 * rows and the households they name, and nothing else.
 *
 * Everything after the household is chosen uses `withHousehold`. If a query
 * here starts reaching accounts or transactions, it is in the wrong function.
 */
export async function withUser<T>(
  client: Client,
  userId: UserId,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return client.unsafe.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user', ${userId}, true)`);
    return work(tx);
  });
}

/**
 * Reports whether the connection is actually subject to row-level security.
 *
 * A role with BYPASSRLS, or one that owns the tables while FORCE is off, sees
 * every household regardless of policies — and nothing about that is visible
 * from the application side. `altitude doctor` and the startup check call this
 * so a misconfigured DATABASE_URL fails loudly at boot rather than quietly at
 * the first cross-tenant read.
 */
export async function assertTenantScopingActive(client: Client): Promise<void> {
  const [row] = await client.sql<{ bypasses: boolean; superuser: boolean; name: string }[]>`
    SELECT rolbypassrls AS bypasses, rolsuper AS superuser, rolname AS name
      FROM pg_roles WHERE rolname = current_user`;

  // Checked before BYPASSRLS because it is the likelier mistake and the more
  // complete bypass. A superuser ignores row-level security entirely, and
  // FORCE ROW LEVEL SECURITY does not reach them either — so migration 0002,
  // which closes the owner exemption, buys nothing here.
  //
  // This is not a hypothetical misconfiguration: the role a Postgres image
  // creates from POSTGRES_USER is a superuser, so the obvious DATABASE_URL —
  // the one docker-compose hands out — lands in exactly this case.
  if (row?.superuser === true) {
    throw new Error(
      `Refusing to start: the database role "${row.name}" is a superuser, so row-level ` +
        'security does not apply to it and households are not isolated. Point DATABASE_URL ' +
        'at the application role (altitude_app).',
    );
  }

  if (row?.bypasses === true) {
    throw new Error(
      `Refusing to start: the database role "${await currentUser(client)}" has BYPASSRLS, ` +
        'so row-level security cannot isolate households. Point DATABASE_URL at the ' +
        'application role (altitude_app), not the migration role.',
    );
  }

  const unforced = await client.sql<{ relname: string }[]>`
    SELECT relname FROM pg_class
     WHERE relname IN ('accounts', 'entries', 'transactions', 'portfolios')
       AND relrowsecurity AND NOT relforcerowsecurity`;

  const [{ owner } = { owner: false }] = await client.sql<{ owner: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_tables
       WHERE schemaname = 'public' AND tablename = 'accounts' AND tableowner = current_user
    ) AS owner`;

  if (owner && unforced.length > 0) {
    throw new Error(
      'Refusing to start: this role owns the tables and FORCE ROW LEVEL SECURITY is off, ' +
        `so policies do not apply to it (${unforced.map((r) => r.relname).join(', ')}). ` +
        'Run the migrations, or point DATABASE_URL at altitude_app.',
    );
  }
}

async function currentUser(client: Client): Promise<string> {
  const [row] = await client.sql<{ user: string }[]>`SELECT current_user AS user`;
  return row?.user ?? 'unknown';
}
