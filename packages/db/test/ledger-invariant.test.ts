import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The invariant lives in two places: packages/core enforces it in TypeScript,
 * and the migrations enforce it in SQL. This suite checks the SQL half against
 * a real PostgreSQL 17 - not a mock, because the behaviour under test is
 * precisely the parts a mock would not have: deferred constraint triggers,
 * exclusion constraints, ltree, and row-level security.
 *
 * The two halves must refuse the same transactions. If one accepts what the
 * other rejects, that gap is a bug, and this is where it surfaces.
 */

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const OTHER_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';
const PORTFOLIO = '33333333-3333-4333-8333-333333333333';
const CURRENT = '44444444-4444-4444-8444-444444444444';
const SAVINGS = '55555555-5555-4555-8555-555555555555';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('altitude')
    .withUsername('altitude')
    .withPassword('altitude')
    .start();

  sql = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });

  // The application role the RLS policies grant to. Created here rather than
  // relying on docker/initdb, so the suite is self-contained.
  await sql.unsafe(`CREATE ROLE altitude_app LOGIN PASSWORD 'altitude_app';`);

  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const contents = await readFile(join(MIGRATIONS, file), 'utf8');
    for (const statement of contents.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') await sql.unsafe(statement);
    }
  }

  await sql`INSERT INTO households ${sql([
    { id: HOUSEHOLD, name: 'Test', base_currency: 'EUR' },
    { id: OTHER_HOUSEHOLD, name: 'Other', base_currency: 'EUR' },
  ])}`;
  await sql`INSERT INTO portfolios ${sql([
    { id: PORTFOLIO, household_id: HOUSEHOLD, path: 'home', name: 'Home' },
  ])}`;
  await sql`INSERT INTO accounts ${sql([
    {
      id: CURRENT,
      household_id: HOUSEHOLD,
      portfolio_id: PORTFOLIO,
      name: 'Current',
      kind: 'cash',
      currency: 'EUR',
    },
    {
      id: SAVINGS,
      household_id: HOUSEHOLD,
      portfolio_id: PORTFOLIO,
      name: 'Savings',
      kind: 'savings',
      currency: 'EUR',
    },
  ])}`;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

/** Posts a transaction and its entries inside one database transaction. */
async function post(id: string, entries: { account: string; amount: string; currency?: string }[]) {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO transactions ${tx([
      { id, household_id: HOUSEHOLD, booked_on: '2026-03-01', kind: 'transfer' },
    ])}`;
    for (const e of entries) {
      await tx`INSERT INTO entries ${tx([
        {
          transaction_id: id,
          household_id: HOUSEHOLD,
          account_id: e.account,
          amount: e.amount,
          currency: e.currency ?? 'EUR',
        },
      ])}`;
    }
  });
}

describe('migrations', () => {
  it('applies cleanly and installs every extension the schema needs', async () => {
    const rows = await sql<{ extname: string }[]>`
      SELECT extname FROM pg_extension
       WHERE extname IN ('ltree','pgcrypto','btree_gist','pg_trgm','unaccent')
       ORDER BY extname`;
    expect(rows.map((r) => r.extname)).toEqual([
      'btree_gist',
      'ltree',
      'pg_trgm',
      'pgcrypto',
      'unaccent',
    ]);
  });

  it('creates every table the schema declares', async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    expect(rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining([
        'accounts',
        'entries',
        'households',
        'memberships',
        'owners',
        'ownerships',
        'portfolios',
        'transactions',
        'users',
      ]),
    );
  });
});

describe('the balance invariant, enforced by the database', () => {
  it('accepts a balanced transaction', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    await post(id, [
      { account: CURRENT, amount: '-300' },
      { account: SAVINGS, amount: '300' },
    ]);
    const rows = await sql<{ amount: string }[]>`
      SELECT amount FROM entries WHERE transaction_id = ${id} ORDER BY amount`;
    expect(rows.map((r) => r.amount)).toEqual(['-300.0000000000', '300.0000000000']);
  });

  it('rejects a transaction that does not sum to zero', async () => {
    await expect(
      post('aaaaaaaa-0000-4000-8000-000000000002', [
        { account: CURRENT, amount: '-300' },
        { account: SAVINGS, amount: '299.99' },
      ]),
    ).rejects.toThrow(/does not balance/);
  });

  it('reports the exact residual - numeric, not float', async () => {
    await expect(
      post('aaaaaaaa-0000-4000-8000-000000000003', [
        { account: CURRENT, amount: '-300' },
        { account: SAVINGS, amount: '299.99' },
      ]),
    ).rejects.toThrow(/off by -0\.01/);
  });

  it('balances per currency, not on a converted total', async () => {
    await expect(
      post('aaaaaaaa-0000-4000-8000-000000000004', [
        { account: CURRENT, amount: '100', currency: 'EUR' },
        { account: SAVINGS, amount: '-100', currency: 'USD' },
      ]),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects a single-sided transaction', async () => {
    await expect(
      post('aaaaaaaa-0000-4000-8000-000000000005', [{ account: CURRENT, amount: '0' }]),
    ).rejects.toThrow(/at least two are required/);
  });

  it('allows entries to be inserted one at a time - the point of deferral', async () => {
    // Each insert is momentarily unbalanced. An immediate trigger would reject
    // the first one and make the whole design unusable.
    const id = 'aaaaaaaa-0000-4000-8000-000000000006';
    await post(id, [
      { account: CURRENT, amount: '-10' },
      { account: SAVINGS, amount: '3' },
      { account: SAVINGS, amount: '7' },
    ]);
    const [row] = await sql<{ n: string; total: string }[]>`
      SELECT count(*)::text AS n, sum(amount)::text AS total
        FROM entries WHERE transaction_id = ${id}`;
    expect(row?.n).toBe('3');
    expect(row?.total).toBe('0.0000000000');
  });

  it('rejects an update that unbalances a previously valid transaction', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000007';
    await post(id, [
      { account: CURRENT, amount: '-50' },
      { account: SAVINGS, amount: '50' },
    ]);
    await expect(
      sql`UPDATE entries SET amount = '49' WHERE transaction_id = ${id} AND amount = '50.0000000000'`,
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects deleting one side of a balanced transaction', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000008';
    await post(id, [
      { account: CURRENT, amount: '-60' },
      { account: SAVINGS, amount: '60' },
    ]);
    await expect(
      sql`DELETE FROM entries WHERE transaction_id = ${id} AND account_id = ${SAVINGS}`,
    ).rejects.toThrow(/does not balance/);
  });
});

describe('holding consistency', () => {
  it('rejects a quantity without an instrument', async () => {
    await expect(
      sql`INSERT INTO entries ${sql([
        {
          transaction_id: 'aaaaaaaa-0000-4000-8000-000000000001',
          household_id: HOUSEHOLD,
          account_id: CURRENT,
          amount: '0',
          currency: 'EUR',
          quantity: '10',
        },
      ])}`,
    ).rejects.toThrow(/entries_holding_consistent/);
  });

  it('rejects a unit price without a quantity', async () => {
    await expect(
      sql`INSERT INTO entries ${sql([
        {
          transaction_id: 'aaaaaaaa-0000-4000-8000-000000000001',
          household_id: HOUSEHOLD,
          account_id: CURRENT,
          amount: '0',
          currency: 'EUR',
          unit_price: '1',
        },
      ])}`,
    ).rejects.toThrow(/entries_unit_price_needs_quantity/);
  });

  it('rejects a value date before the booking date', async () => {
    await expect(
      sql`INSERT INTO transactions ${sql([
        {
          id: 'bbbbbbbb-0000-4000-8000-000000000001',
          household_id: HOUSEHOLD,
          booked_on: '2026-03-01',
          value_on: '2026-02-28',
          kind: 'transfer',
        },
      ])}`,
    ).rejects.toThrow(/transactions_value_after_booking/);
  });
});

describe('numeric precision reaches the database intact', () => {
  it('stores eighteen decimals of quantity without loss', async () => {
    const [row] = await sql<{ q: string }[]>`
      SELECT '0.000000000000000001'::numeric(38,18) AS q`;
    expect(row?.q).toBe('0.000000000000000001');
  });

  it('adds exactly, where float8 does not', async () => {
    const [row] = await sql<{ exact: boolean; sloppy: boolean }[]>`
      SELECT (0.1::numeric + 0.2::numeric = 0.3::numeric) AS exact,
             (0.1::float8  + 0.2::float8  = 0.3::float8)  AS sloppy`;
    expect(row?.exact).toBe(true);
    expect(row?.sloppy).toBe(false);
  });
});

describe('portfolio tree', () => {
  it('answers a subtree query with the ltree operator', async () => {
    await sql`INSERT INTO portfolios ${sql([
      { household_id: HOUSEHOLD, path: 'home.children', name: 'Children' },
      { household_id: HOUSEHOLD, path: 'home.children.lea', name: 'Lea' },
      { household_id: HOUSEHOLD, path: 'other', name: 'Other' },
    ])}`;
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM portfolios WHERE path <@ 'home'::ltree ORDER BY path`;
    expect(rows.map((r) => r.name)).toEqual(['Home', 'Children', 'Lea']);
  });
});

describe('ownership shares cannot overlap', () => {
  it('rejects two overlapping periods for the same owner and account', async () => {
    const owner = '66666666-6666-4666-8666-666666666666';
    await sql`INSERT INTO owners ${sql([
      { id: owner, household_id: HOUSEHOLD, kind: 'person', display_name: 'Marc' },
    ])}`;
    await sql`INSERT INTO ownerships ${sql([
      {
        account_id: CURRENT,
        owner_id: owner,
        share: '0.5',
        valid_from: '2020-01-01',
        valid_to: '2025-12-31',
      },
    ])}`;
    await expect(
      sql`INSERT INTO ownerships ${sql([
        {
          account_id: CURRENT,
          owner_id: owner,
          share: '0.5',
          valid_from: '2025-06-01',
          valid_to: '2030-01-01',
        },
      ])}`,
    ).rejects.toThrow(/ownerships_no_overlap/);
  });
});

describe('row-level security', () => {
  it('hides another household from the application role', async () => {
    const app = postgres(container.getConnectionUri(), {
      max: 1,
      onnotice: () => {},
      username: 'altitude_app',
      password: 'altitude_app',
    });
    try {
      const rows = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_household', ${OTHER_HOUSEHOLD}, true)`;
        return tx<{ id: string }[]>`SELECT id FROM accounts`;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await app.end();
    }
  });

  it('shows only the current household', async () => {
    const app = postgres(container.getConnectionUri(), {
      max: 1,
      onnotice: () => {},
      username: 'altitude_app',
      password: 'altitude_app',
    });
    try {
      const rows = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_household', ${HOUSEHOLD}, true)`;
        return tx<{ id: string }[]>`SELECT id FROM accounts ORDER BY name`;
      });
      expect(rows.map((r) => r.id)).toEqual([CURRENT, SAVINGS]);
    } finally {
      await app.end();
    }
  });

  it('returns nothing when the tenant was never set - it fails closed', async () => {
    const app = postgres(container.getConnectionUri(), {
      max: 1,
      onnotice: () => {},
      username: 'altitude_app',
      password: 'altitude_app',
    });
    try {
      const rows = await app<{ id: string }[]>`SELECT id FROM accounts`;
      expect(rows).toHaveLength(0);
    } finally {
      await app.end();
    }
  });
});
