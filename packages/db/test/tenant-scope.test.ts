import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { householdId } from '@altitude/shared';
import { createClient, withHousehold, assertTenantScopingActive, type Client } from '../src/index';
import { accounts } from '../src/schema/structure';

/**
 * The first barrier of ADR-0007, and proof that the second one is actually load
 * bearing.
 *
 * Migration 0002 exists because ENABLE ROW LEVEL SECURITY does not apply to the
 * role owning the tables — and that role is exactly what docker-compose hands
 * out as DATABASE_URL. The failure was invisible from every angle an
 * application could check: policies listed, relrowsecurity true, and every row
 * returned anyway. These tests pin the fix down.
 */

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
let appClient: Client;
let ownerClient: Client;

const HOUSE_A = householdId('11111111-1111-4111-8111-111111111111');
const HOUSE_B = householdId('22222222-2222-4222-8222-222222222222');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('altitude')
    .withUsername('altitude')
    .withPassword('altitude')
    .start();

  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE ROLE altitude_app LOGIN PASSWORD 'altitude_app';`);

  for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    const contents = await readFile(join(MIGRATIONS, file), 'utf8');
    for (const statement of contents.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') await admin.unsafe(statement);
    }
  }

  // Seeded with BYPASSRLS so the fixture itself is not subject to the policies
  // it is setting up. Two households, one account each.
  await admin.unsafe(`ALTER ROLE altitude SET row_security = off;`);
  for (const [house, name] of [
    [HOUSE_A, 'A'],
    [HOUSE_B, 'B'],
  ] as const) {
    await admin`INSERT INTO households ${admin([{ id: house, name }])}`;
    const [p] = await admin<{ id: string }[]>`
      INSERT INTO portfolios ${admin([{ household_id: house, path: `home_${name}`, name }])}
      RETURNING id`;
    await admin`INSERT INTO accounts ${admin([
      {
        household_id: house,
        portfolio_id: p!.id,
        name: `Account ${name}`,
        kind: 'cash',
        currency: 'EUR',
      },
    ])}`;
  }
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

  const uri = new URL(container.getConnectionUri());
  const appUri = `postgres://altitude_app:altitude_app@${uri.hostname}:${uri.port}${uri.pathname}`;
  appClient = createClient({ url: appUri, max: 2 });
  ownerClient = createClient({ url: container.getConnectionUri(), max: 2 });
}, 180_000);

afterAll(async () => {
  await appClient?.close();
  await ownerClient?.close();
  await admin?.end();
  await container?.stop();
});

describe('withHousehold binds a unit of work to one tenant', () => {
  it('returns only the current household', async () => {
    const rows = await withHousehold(appClient, { householdId: HOUSE_A }, (tx) =>
      tx.select({ name: accounts.name }).from(accounts),
    );
    expect(rows.map((r) => r.name)).toEqual(['Account A']);
  });

  it('returns the other household when scoped to it', async () => {
    const rows = await withHousehold(appClient, { householdId: HOUSE_B }, (tx) =>
      tx.select({ name: accounts.name }).from(accounts),
    );
    expect(rows.map((r) => r.name)).toEqual(['Account B']);
  });

  it('sees nothing outside a scoped unit of work', async () => {
    const rows = await appClient.unsafe.select({ name: accounts.name }).from(accounts);
    expect(rows).toHaveLength(0);
  });

  it('discards the tenant at the end of the transaction', async () => {
    // The setting is SET LOCAL, so it dies with the transaction. A plain SET
    // would survive on the pooled connection and hand one household's identity
    // to whoever picked that connection up next.
    await withHousehold(appClient, { householdId: HOUSE_A }, async (tx) => {
      const [row] = await tx.execute<{ v: string | null }>(
        sql`SELECT current_setting('app.current_household', true) AS v`,
      );
      expect(row?.v).toBe(HOUSE_A);
    });

    const [after] = await appClient.sql<{ v: string | null }[]>`
      SELECT current_setting('app.current_household', true) AS v`;
    expect(after?.v ?? '').toBe('');
  });

  it('rolls back without leaking the tenant', async () => {
    await expect(
      withHousehold(appClient, { householdId: HOUSE_A }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const [after] = await appClient.sql<{ v: string | null }[]>`
      SELECT current_setting('app.current_household', true) AS v`;
    expect(after?.v ?? '').toBe('');
  });

  it('refuses to write into another household', async () => {
    // Drizzle wraps the driver error, so the assertion reads the cause: 42501
    // is insufficient_privilege, which is what a WITH CHECK violation raises.
    const attempt = withHousehold(appClient, { householdId: HOUSE_A }, (tx) =>
      tx.execute(sql`
          INSERT INTO households (id, name)
          VALUES ('33333333-3333-4333-8333-333333333333', 'Smuggled')`),
    );
    await expect(attempt).rejects.toThrow();
    await attempt.catch((error: unknown) => {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      expect(cause?.code).toBe('42501');
      expect(cause?.message).toMatch(/row-level security/i);
    });
  });
});

describe('FORCE ROW LEVEL SECURITY closes the owner exemption', () => {
  it('does not save a superuser — which is why the startup check exists', async () => {
    // FORCE reaches a non-superuser table owner. It does not reach a superuser,
    // and the role a Postgres image creates from POSTGRES_USER is one. So this
    // connection sees every household despite RLS being enabled and forced.
    //
    // The assertion is inverted on purpose: it records the limit of the SQL
    // barrier, so that removing assertTenantScopingActive breaks a test rather
    // than quietly removing the only thing covering this case.
    const rows = await ownerClient.unsafe.select({ name: accounts.name }).from(accounts);
    expect(rows).toHaveLength(2);
    await expect(assertTenantScopingActive(ownerClient)).rejects.toThrow(/superuser/);
  });

  it('reports FORCE as enabled on every household table', async () => {
    const rows = await admin<{ relname: string }[]>`
      SELECT relname FROM pg_class
       WHERE relrowsecurity AND NOT relforcerowsecurity
         AND relname IN ('households','memberships','owners','portfolios',
                         'accounts','ownerships','transactions','entries')`;
    expect(rows).toEqual([]);
  });
});

describe('assertTenantScopingActive', () => {
  it('accepts the application role', async () => {
    await expect(assertTenantScopingActive(appClient)).resolves.toBeUndefined();
  });

  it('rejects a role that bypasses row-level security', async () => {
    await admin.unsafe(`CREATE ROLE altitude_migrate LOGIN PASSWORD 'm' BYPASSRLS;`);
    const uri = new URL(container.getConnectionUri());
    const client = createClient({
      url: `postgres://altitude_migrate:m@${uri.hostname}:${uri.port}${uri.pathname}`,
      max: 1,
    });
    try {
      await expect(assertTenantScopingActive(client)).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await client.close();
    }
  });
});
