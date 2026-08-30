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
  AlreadyReversedError,
  ForbiddenError,
  TenantScopeError,
  TransactionNotFoundError,
  UnbalancedTransactionError,
  accountBalances,
  listTransactions,
  netWorth,
  postTransaction,
  reverseTransactionById,
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
let opening: AccountId;
let mortgage: AccountId;

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
      // Where money entering the household comes from. Equity, not a liability:
      // it is the counterpart that makes a first deposit balance, and net worth
      // leaves it out by class rather than by anyone remembering to.
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Opening',
        kind: 'opening_balance',
        currency: 'EUR',
      },
      // Real debt, so that net worth is exercised against something it must
      // subtract rather than only against things it adds.
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Mortgage',
        kind: 'loan',
        currency: 'EUR',
      },
    ])} RETURNING id, name`;
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

  current = accountId(made.find((a) => a.name === 'Current')!.id);
  savings = accountId(made.find((a) => a.name === 'Savings')!.id);
  opening = accountId(made.find((a) => a.name === 'Opening')!.id);
  mortgage = accountId(made.find((a) => a.name === 'Mortgage')!.id);

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
          { accountId: opening, amount: Money.of('-1000', 'EUR') },
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
    expect(byName['Opening']).toBe('-1000');

    // Every balance, unfiltered. The caller does not choose what counts: the
    // opening account is equity and drops out on its own, which is the whole
    // reason the class exists.
    expect(netWorth(balances, 'EUR').amount.toFixed()).toBe('1000');
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
    expect(balances).toHaveLength(4);
    // The mortgage has had no transaction yet. An account that vanished until
    // its first one would look like a bug to whoever had just created it.
    expect(balances.find((b) => b.name === 'Mortgage')?.balance.amount.toFixed()).toBe('0');
  });

  /**
   * The regression for the bug this class was added to fix.
   *
   * Drawing down a mortgage moves 150,000 into the current account and owes
   * 150,000, so net worth does not move. Before `classification` existed the
   * dashboard summed asset accounts only - because the opening balance account
   * was typed as a liability and had to be hidden somehow - and this household
   * would have reported 151,000. Being suddenly richer by the size of the loan
   * is a wrong answer nobody reports.
   */
  it('does not make a household richer for borrowing', async () => {
    const before = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );

    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      postTransaction(tx, owner, {
        id: transactionId('aaaaaaaa-0000-4000-8000-00000000000a'),
        bookedOn: ledgerDate('2026-03-04'),
        kind: 'transfer',
        description: 'Mortgage drawdown',
        entries: [
          { accountId: current, amount: Money.of('150000', 'EUR') },
          { accountId: mortgage, amount: Money.of('-150000', 'EUR') },
        ],
      }),
    );

    const after = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );

    // Both the value and the fact it did not move. Equality alone would pass
    // against a netWorth that counted equity too, since that returns zero on
    // either side of the drawdown.
    expect(netWorth(before, 'EUR').amount.toFixed()).toBe('1000');
    expect(netWorth(after, 'EUR').amount.toFixed()).toBe('1000');
    expect(netWorth(after, 'EUR').equals(netWorth(before, 'EUR'))).toBe(true);

    const byName = Object.fromEntries(after.map((b) => [b.name, b]));
    expect(byName['Mortgage']!.classification).toBe('liability');
    expect(byName['Opening']!.classification).toBe('equity');
    expect(byName['Current']!.classification).toBe('asset');

    // Repaying it moves net worth up by exactly what was repaid, which is the
    // other half of the same claim.
    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      postTransaction(tx, owner, {
        id: transactionId('aaaaaaaa-0000-4000-8000-00000000000b'),
        bookedOn: ledgerDate('2026-03-05'),
        kind: 'transfer',
        description: 'Repayment',
        entries: [
          { accountId: current, amount: Money.of('-500', 'EUR') },
          { accountId: mortgage, amount: Money.of('500', 'EUR') },
        ],
      }),
    );

    const repaid = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );
    expect(netWorth(repaid, 'EUR').equals(netWorth(before, 'EUR'))).toBe(true);
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

describe('listTransactions', () => {
  it('returns the ledger newest first, with every line of each transaction', async () => {
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, {}),
    );

    expect(page.transactions.length).toBeGreaterThan(0);

    const dates = page.transactions.map((entry) => entry.bookedOn);
    expect([...dates].sort().reverse()).toEqual(dates);

    // Every transaction in this ledger balances, so every line of every one of
    // them sums to nothing. This is the invariant of ADR-0002, read back out of
    // the shape the screen will render rather than out of the database.
    for (const entry of page.transactions) {
      const base: string = 'EUR';
      const sum = entry.lines.reduce((total, line) => total.plus(line.amount), Money.zero(base));
      expect(sum.isZero(), `${entry.id} does not balance`).toBe(true);
      expect(entry.lines.length).toBeGreaterThanOrEqual(2);
      // Names, not identifiers: the screen shows accounts, and resolving them
      // one query per row is how a list of twenty becomes forty-one queries.
      expect(entry.lines.every((line) => line.accountName !== '')).toBe(true);
    }
  });

  it('numbers its pages, and counts what it did not return', async () => {
    const first = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 2, page: 1 }),
    );
    expect(first.transactions).toHaveLength(2);
    expect(first.page).toBe(1);
    // The count is of everything matching, not of what came back - it is what
    // lets a reader be told "1 of 4" rather than only "there is more".
    expect(first.total).toBeGreaterThan(2);
    expect(first.pageCount).toBe(Math.ceil(first.total / 2));

    const second = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 2, page: 2 }),
    );
    const firstIds = first.transactions.map((entry) => entry.id);
    const secondIds = second.transactions.map((entry) => entry.id);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect(second.total).toBe(first.total);
  });

  it('clamps a page number past the end instead of skipping a billion rows', async () => {
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 2, page: 9999 }),
    );
    // Clamped, not honoured. An unbounded page number is an OFFSET anyone can
    // make arbitrarily large from the address bar.
    expect(page.page).toBe(page.pageCount);
    expect(page.transactions.length).toBeGreaterThan(0);
  });

  it('counts every match, not only the page it returned', async () => {
    const paged = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 2 }),
    );
    const everything = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 200 }),
    );
    // The count is what makes "page 3 of 40" possible, so it has to be the real
    // number rather than a floor - the version that capped it made every page
    // past 400 unreachable.
    expect(paged.total).toBe(everything.transactions.length);
    expect(paged.pageCount).toBe(Math.ceil(paged.total / 2));
  });

  it('filters to one account', async () => {
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { accountId: mortgage, perPage: 50 }),
    );
    expect(page.transactions.length).toBeGreaterThan(0);
    for (const entry of page.transactions) {
      expect(entry.lines.some((line) => line.accountId === mortgage)).toBe(true);
    }
  });

  it('refuses an actor from another household', async () => {
    const stranger: Actor = { userId: USER, householdId: OTHER, role: 'owner' };
    await expect(
      withHousehold(client, { householdId: HOUSE }, (tx) => listTransactions(tx, stranger, {})),
    ).rejects.toThrow(TenantScopeError);
  });
});

describe('reverseTransactionById', () => {
  it('cancels a transaction by adding to the ledger, never by editing it', async () => {
    const before = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );
    const beforeWorth = netWorth(before, 'EUR');

    const id = transactionId('cccccccc-0000-4000-8000-000000000001');
    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      postTransaction(tx, owner, {
        id,
        bookedOn: ledgerDate('2026-04-01'),
        kind: 'deposit',
        description: 'A mistake',
        entries: [
          { accountId: current, amount: Money.of('500', 'EUR') },
          { accountId: opening, amount: Money.of('-500', 'EUR') },
        ],
      }),
    );

    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      reverseTransactionById(
        tx,
        owner,
        id,
        transactionId('cccccccc-0000-4000-8000-000000000002'),
        ledgerDate('2026-04-02'),
      ),
    );

    const after = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      accountBalances(tx, owner),
    );
    expect(netWorth(after, 'EUR').equals(beforeWorth)).toBe(true);

    // Both rows survive. Correcting a ledger adds to it; the original stays
    // readable and what cancelled it sits beside it (ADR-0002).
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 50 }),
    );
    const original = page.transactions.find((t) => t.id === id);
    const reversal = page.transactions.find((t) => t.reversesId === id);

    expect(original?.description).toBe('A mistake');
    expect(original?.reversedById).toBe(reversal?.id);
    expect(reversal?.reversesId).toBe(id);
  });

  it('refuses to reverse the same transaction twice', async () => {
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 50 }),
    );
    const reversed = page.transactions.find((t) => t.reversedById !== null)!;

    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        reverseTransactionById(
          tx,
          owner,
          reversed.id,
          transactionId('cccccccc-0000-4000-8000-000000000003'),
          ledgerDate('2026-04-03'),
        ),
      ),
    ).rejects.toThrow(AlreadyReversedError);
  });

  it('refuses an id from another household the same way as one that does not exist', async () => {
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        reverseTransactionById(
          tx,
          owner,
          transactionId('dddddddd-0000-4000-8000-000000000009'),
          transactionId('cccccccc-0000-4000-8000-000000000004'),
          ledgerDate('2026-04-03'),
        ),
      ),
    ).rejects.toThrow(TransactionNotFoundError);
  });

  it('refuses a viewer', async () => {
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 1 }),
    );
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        reverseTransactionById(
          tx,
          viewer,
          page.transactions[0]!.id,
          transactionId('cccccccc-0000-4000-8000-000000000005'),
          ledgerDate('2026-04-03'),
        ),
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});
