import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  Money,
  accountId,
  householdId,
  ledgerDate,
  transactionId,
  userId,
  type AccountId,
} from '@altitude/shared';
import { createClient, withHousehold, type Client } from '@altitude/db';
import {
  ForbiddenError,
  TenantScopeError,
  UnbalancedTransactionError,
  accountBalances,
  netWorth,
  postTransaction,
  type Actor,
} from '../src/index';

/**
 * The week 1 verification of plan §18, this time through the real stack:
 * service, permission check, tenant-scoped transaction, and PostgreSQL.
 *
 *   "Record a EUR 1,000 deposit and a EUR 300 transfer to a second account, and
 *    see a net worth of EUR 1,000 - not EUR 1,300."
 *
 * The unit tests already assert this against an in-memory ledger. Here the
 * numbers come back out of the database, summed by it, which is the version a
 * user would see.
 */

// The migrations live in @altitude/db; core depends on it, so reaching them
// here follows the dependency rather than crossing it.
const MIGRATIONS = join(import.meta.dirname, '..', '..', 'db', 'migrations');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
let client: Client;

const HOUSE = householdId('11111111-1111-4111-8111-111111111111');
const OTHER = householdId('22222222-2222-4222-8222-222222222222');
const USER = userId('33333333-3333-4333-8333-333333333333');

let current: AccountId;
let savings: AccountId;
let income: AccountId;

const owner: Actor = { userId: USER, householdId: HOUSE, role: 'owner' };
const viewer: Actor = { userId: USER, householdId: HOUSE, role: 'viewer' };

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

  await admin.unsafe(`ALTER ROLE altitude SET row_security = off;`);
  await admin`INSERT INTO users ${admin([
    { id: USER, email: 'marc@example.test', display_name: 'Marc' },
  ])}`;
  await admin`INSERT INTO households ${admin([
    { id: HOUSE, name: 'Lecomte', base_currency: 'EUR' },
    { id: OTHER, name: 'Elsewhere', base_currency: 'EUR' },
  ])}`;
  const [portfolio] = await admin<{ id: string }[]>`
    INSERT INTO portfolios ${admin([{ household_id: HOUSE, path: 'home', name: 'Home' }])}
    RETURNING id`;

  const made = await admin<{ id: string; name: string }[]>`
    INSERT INTO accounts ${admin([
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Current',
        kind: 'cash',
        currency: 'EUR',
      },
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Savings',
        kind: 'savings',
        currency: 'EUR',
      },
      // Where money entering the household comes from. Not an asset, so it is
      // excluded from net worth below the same way the unit test excludes it.
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Income',
        kind: 'other_liability',
        currency: 'EUR',
      },
    ])} RETURNING id, name`;
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

  current = accountId(made.find((a) => a.name === 'Current')!.id);
  savings = accountId(made.find((a) => a.name === 'Savings')!.id);
  income = accountId(made.find((a) => a.name === 'Income')!.id);

  const uri = new URL(container.getConnectionUri());
  client = createClient({
    url: `postgres://altitude_app:altitude_app@${uri.hostname}:${uri.port}${uri.pathname}`,
    max: 2,
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.end();
  await container?.stop();
});

describe('postTransaction - the week 1 number, through the database', () => {
  it('records a deposit and a transfer, and reports 1000 rather than 1300', async () => {
    await withHousehold(client, { householdId: HOUSE, userId: USER }, async (tx) => {
      await postTransaction(tx, owner, {
        id: transactionId('aaaaaaaa-0000-4000-8000-000000000001'),
        bookedOn: ledgerDate('2026-03-01'),
        kind: 'deposit',
        description: 'Salary',
        entries: [
          { accountId: current, amount: Money.of('1000', 'EUR') },
          { accountId: income, amount: Money.of('-1000', 'EUR') },
        ],
      });

      await postTransaction(tx, owner, {
        id: transactionId('aaaaaaaa-0000-4000-8000-000000000002'),
        bookedOn: ledgerDate('2026-03-02'),
        kind: 'transfer',
        description: 'Move to savings',
        entries: [
          { accountId: current, amount: Money.of('-300', 'EUR') },
          { accountId: savings, amount: Money.of('300', 'EUR') },
        ],
      });
    });

    const balances = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );

    const byName = Object.fromEntries(balances.map((b) => [b.name, b.balance.amount.toFixed()]));
    expect(byName['Current']).toBe('700');
    expect(byName['Savings']).toBe('300');
    expect(byName['Income']).toBe('-1000');

    // Net worth over the asset accounts only - the same shape as the unit test.
    const assets = balances.filter((b) => b.name !== 'Income');
    expect(netWorth(assets, 'EUR').amount.toFixed()).toBe('1000');
  });

  it('sums exactly, with no float anywhere between the column and the result', async () => {
    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      postTransaction(tx, owner, {
        id: transactionId('aaaaaaaa-0000-4000-8000-000000000003'),
        bookedOn: ledgerDate('2026-03-03'),
        kind: 'transfer',
        entries: [
          { accountId: current, amount: Money.of('-0.1', 'EUR') },
          { accountId: savings, amount: Money.of('0.1', 'EUR') },
        ],
      }),
    );
    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      postTransaction(tx, owner, {
        id: transactionId('aaaaaaaa-0000-4000-8000-000000000004'),
        bookedOn: ledgerDate('2026-03-03'),
        kind: 'transfer',
        entries: [
          { accountId: current, amount: Money.of('-0.2', 'EUR') },
          { accountId: savings, amount: Money.of('0.2', 'EUR') },
        ],
      }),
    );

    const balances = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );
    // 300 + 0.1 + 0.2, which a float accumulator renders as 300.30000000000007.
    expect(balances.find((b) => b.name === 'Savings')?.balance.amount.toFixed()).toBe('300.3');
    expect(balances.find((b) => b.name === 'Current')?.balance.amount.toFixed()).toBe('699.7');
  });

  it('shows an account with no entries at zero rather than hiding it', async () => {
    const balances = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );
    expect(balances).toHaveLength(3);
  });
});

describe('postTransaction - the checks it must not skip', () => {
  it('refuses a viewer before looking at the input', async () => {
    // The entries below are unbalanced. A viewer must be refused for their role,
    // not told their data is wrong: the order of the checks is the point.
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        postTransaction(tx, viewer, {
          id: transactionId('bbbbbbbb-0000-4000-8000-000000000001'),
          bookedOn: ledgerDate('2026-03-04'),
          kind: 'transfer',
          entries: [
            { accountId: current, amount: Money.of('-1', 'EUR') },
            { accountId: savings, amount: Money.of('999', 'EUR') },
          ],
        }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses an unbalanced transaction before it reaches the database', async () => {
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        postTransaction(tx, owner, {
          id: transactionId('bbbbbbbb-0000-4000-8000-000000000002'),
          bookedOn: ledgerDate('2026-03-04'),
          kind: 'transfer',
          entries: [
            { accountId: current, amount: Money.of('-1', 'EUR') },
            { accountId: savings, amount: Money.of('999', 'EUR') },
          ],
        }),
      ),
    ).rejects.toThrow(UnbalancedTransactionError);
  });

  it('refuses an actor whose household is not the one this work is bound to', async () => {
    // Row-level security would still return the right rows here, so nothing
    // would look wrong - the caller would simply be acting for a household it
    // did not intend. The service refuses rather than serving that.
    const outsider: Actor = { userId: USER, householdId: OTHER, role: 'owner' };
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        accountBalances(tx, outsider),
      ),
    ).rejects.toThrow(TenantScopeError);
  });

  it('refuses work that was never bound to a household at all', async () => {
    await expect(accountBalances(client.unsafe, owner)).rejects.toThrow(/not bound to a household/);
  });

  it('leaves nothing behind when a transaction is rejected', async () => {
    const before = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );

    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, async (tx) => {
        await postTransaction(tx, owner, {
          id: transactionId('bbbbbbbb-0000-4000-8000-000000000003'),
          bookedOn: ledgerDate('2026-03-05'),
          kind: 'transfer',
          entries: [
            { accountId: current, amount: Money.of('-5', 'EUR') },
            { accountId: savings, amount: Money.of('5', 'EUR') },
          ],
        });
        throw new Error('something later failed');
      }),
    ).rejects.toThrow('something later failed');

    const after = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );
    expect(after.map((b) => b.balance.amount.toFixed())).toEqual(
      before.map((b) => b.balance.amount.toFixed()),
    );
  });
});
