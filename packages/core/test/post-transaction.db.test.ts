import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import {
  Money,
  accountId,
  dec,
  householdId,
  instrumentId,
  ledgerDate,
  transactionId,
  userId,
  type AccountId,
} from '@altitude/shared';
import { createClient, withHousehold, type Client } from '@altitude/db';
import {
  AlreadyReversedError,
  CurrencyDoesNotMatchAccountError,
  createAccount,
  ForbiddenError,
  TenantScopeError,
  TransactionNotFoundError,
  UnbalancedTransactionError,
  accountBalances,
  listTransactions,
  netWorth,
  postTransaction,
  postTransactions,
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
let dollars: AccountId;

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
      // Not euros, so an entry can be posted at the wrong account and refused.
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Dollars',
        kind: 'cash',
        currency: 'USD',
      },
    ])} RETURNING id, name`;
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

  current = accountId(made.find((a) => a.name === 'Current')!.id);
  savings = accountId(made.find((a) => a.name === 'Savings')!.id);
  opening = accountId(made.find((a) => a.name === 'Opening')!.id);
  mortgage = accountId(made.find((a) => a.name === 'Mortgage')!.id);
  dollars = accountId(made.find((a) => a.name === 'Dollars')!.id);

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

/** Raw SQL, for the one table no service exposes yet. */
const sqlFor = (text: string) => sql.raw(text);

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
    expect(balances).toHaveLength(5);
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

  it('filters by period, inclusive at both ends', async () => {
    const all = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 200 }),
    );
    const day = all.transactions[0]!.bookedOn;

    const onlyThatDay = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 200, from: ledgerDate(day), to: ledgerDate(day) }),
    );

    expect(onlyThatDay.transactions.length).toBeGreaterThan(0);
    expect(onlyThatDay.transactions.every((e) => e.bookedOn === day)).toBe(true);
    // Inclusive: a range whose ends are the same day still contains that day.
    expect(onlyThatDay.total).toBeLessThan(all.total);
  });

  it('filters by kind', async () => {
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 200, kind: 'transfer' }),
    );
    expect(page.transactions.length).toBeGreaterThan(0);
    expect(page.transactions.every((e) => e.kind === 'transfer')).toBe(true);
  });

  it('filters to reversals, and to what they reversed', async () => {
    // Makes its own pair rather than relying on another test having run. Tests
    // that depend on the order of the file fail in a way that blames the wrong
    // one, and this file already shares a database between its cases.
    const original = transactionId('eeeeeeee-0000-4000-8000-000000000001');
    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      postTransaction(tx, owner, {
        id: original,
        bookedOn: ledgerDate('2026-05-01'),
        kind: 'deposit',
        description: 'To be undone',
        entries: [
          { accountId: current, amount: Money.of('40', 'EUR') },
          { accountId: opening, amount: Money.of('-40', 'EUR') },
        ],
      }),
    );
    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      reverseTransactionById(
        tx,
        owner,
        original,
        transactionId('eeeeeeee-0000-4000-8000-000000000002'),
        ledgerDate('2026-05-02'),
      ),
    );

    const reversals = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 200, status: 'reversal' }),
    );
    const reversed = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 200, status: 'reversed' }),
    );

    expect(reversals.transactions.length).toBeGreaterThan(0);
    expect(reversals.transactions.every((e) => e.reversesId !== null)).toBe(true);
    expect(reversed.transactions.every((e) => e.reversedById !== null)).toBe(true);

    // The two are opposite ends of the same pairs, so they match one for one.
    expect(reversals.total).toBe(reversed.total);
    expect(reversals.transactions.map((e) => e.reversesId).sort()).toEqual(
      reversed.transactions.map((e) => e.id).sort(),
    );
  });

  it('counts what the filter matches, not what the table holds', async () => {
    const everything = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 1 }),
    );
    const reversals = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 1, status: 'reversal' }),
    );
    // The count and the page share one predicate. If they ever drifted apart,
    // the page numbers would point at rows the list cannot show.
    expect(reversals.total).toBeGreaterThan(0);
    expect(reversals.total).toBeLessThan(everything.total);
    expect(reversals.pageCount).toBe(reversals.total);
  });

  it('combines filters rather than picking one', async () => {
    const page = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      listTransactions(tx, owner, { perPage: 200, kind: 'transfer', accountId: mortgage }),
    );
    for (const entry of page.transactions) {
      expect(entry.kind).toBe('transfer');
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

describe('an entry may only move the currency its account holds', () => {
  /**
   * The defect this closes was not an error but a wrong number.
   *
   * Double entry balances per currency, so two euro entries balance each other
   * whatever accounts they name. Nothing then compared them to the accounts,
   * and `accountBalances` sums `amount` without reading `currency` and labels
   * the total with the account's own - so a dollar account full of euro entries
   * reported a dollar balance that was really a pile of euros. Reported from a
   * real import, where an account showed "400.79 $US" of euros.
   */
  it('refuses euros posted into a dollar account', async () => {
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        postTransaction(tx, owner, {
          id: transactionId('dddddddd-0000-4000-8000-000000000001'),
          bookedOn: ledgerDate('2026-05-01'),
          kind: 'deposit',
          entries: [
            { accountId: dollars, amount: Money.of('50', 'EUR') },
            { accountId: opening, amount: Money.of('-50', 'EUR') },
          ],
        }),
      ),
    ).rejects.toThrow(CurrencyDoesNotMatchAccountError);
  });

  it('names the account and both currencies, so the message is actionable', async () => {
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        postTransaction(tx, owner, {
          id: transactionId('dddddddd-0000-4000-8000-000000000002'),
          bookedOn: ledgerDate('2026-05-01'),
          kind: 'deposit',
          entries: [
            { accountId: dollars, amount: Money.of('50', 'EUR') },
            { accountId: opening, amount: Money.of('-50', 'EUR') },
          ],
        }),
      ),
    ).rejects.toThrow(/Dollars is held in USD, and this entry is in EUR/);
  });

  it('accepts the same movement in the currency the account holds', async () => {
    // Balanced in dollars on both sides, so nothing here is about the account
    // it lands in - only about the currency agreeing with it.
    const usdOpening = await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      createAccount(tx, owner, { name: 'Opening USD', kind: 'cash', currency: 'USD' }),
    );

    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        postTransaction(tx, owner, {
          id: transactionId('dddddddd-0000-4000-8000-000000000003'),
          bookedOn: ledgerDate('2026-05-01'),
          kind: 'transfer',
          entries: [
            { accountId: dollars, amount: Money.of('50', 'USD') },
            { accountId: accountId(usdOpening.id), amount: Money.of('-50', 'USD') },
          ],
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe('reversing a transaction that holds an instrument', () => {
  /**
   * A purchase reversed came back as a quantity of nothing.
   *
   * The rebuild read four columns - account, amount, currency, quantity - and
   * not `instrument_id`, so the domain was handed a holding line with a
   * quantity and no instrument and refused it by name. Every cash transfer
   * reversed fine, which is why this survived: the gap only shows the day
   * something reverses a trade, and undoing a broker import does exactly that.
   */
  it('keeps the instrument, the quantity and the unit price', async () => {
    const instrument = await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      tx.execute<{ id: string }>(
        sqlFor(`INSERT INTO instruments (isin, name, currency, kind)
                VALUES ('FR0000000042', 'A fund', 'EUR', 'fund') RETURNING id`),
      ),
    );
    const held = instrumentId([...instrument][0]!.id);

    const bought = transactionId('ffffffff-0000-4000-8000-000000000001');
    await withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
      postTransaction(tx, owner, {
        id: bought,
        bookedOn: ledgerDate('2026-07-01'),
        kind: 'buy',
        entries: [
          { accountId: current, amount: Money.of('-250', 'EUR') },
          {
            accountId: current,
            amount: Money.of('250', 'EUR'),
            quantity: dec('10'),
            unitPrice: Money.of('25', 'EUR'),
            instrumentId: held,
          },
        ],
      }),
    );

    const reversalId = transactionId('ffffffff-0000-4000-8000-000000000002');
    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        reverseTransactionById(tx, owner, bought, reversalId, ledgerDate('2026-07-02')),
      ),
    ).resolves.toBeDefined();

    // And the opposite carries the holding too, so a position derived from the
    // entries nets to zero rather than to ten shares of nothing.
    const lines = await withHousehold(client, { householdId: HOUSE }, (tx) =>
      tx.execute<{ quantity: string | null; instrument_id: string | null }>(
        sqlFor(`SELECT quantity::text, instrument_id FROM entries
                 WHERE transaction_id = '${reversalId}'::uuid AND quantity IS NOT NULL`),
      ),
    );
    expect([...lines]).toHaveLength(1);
    expect([...lines][0]?.instrument_id).toBe(held);
    expect(Number([...lines][0]?.quantity)).toBe(-10);
  });
});

/**
 * The same guarantees, for a thousand transactions at once.
 *
 * Last in the file, and that is not tidiness: these write six hundred rows into
 * the ledger the tests above count, and a suite that shares a household reads
 * whatever ran before it.
 *
 * An import posts one row per movement, and one call each cost five round trips
 * a row - about six minutes for a file at the ceiling, nearly all of it waiting
 * on the network. Batching drops the round trips; what it must not drop is any
 * check, so what is tested here is that every refusal still refuses.
 *
 * Every figure is invented.
 */
describe('postTransactions - what batching must not skip', () => {
  const pair = (at: number, prefix: string, amount = '10.00') => ({
    id: transactionId(
      `${prefix}-0000-4000-8000-${String(at + 1).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
    ),
    bookedOn: ledgerDate('2026-06-01'),
    kind: 'withdrawal' as const,
    description: `CARTE 01/06 COMMERCE INVENTE ${String(at)}`,
    entries: [
      { accountId: current, amount: Money.of(`-${amount}`, 'EUR') },
      { accountId: opening, amount: Money.of(amount, 'EUR') },
    ],
  });

  const post = (actor: Actor, inputs: readonly Parameters<typeof postTransaction>[2][]) =>
    withHousehold(client, { householdId: actor.householdId, userId: USER }, (tx) =>
      postTransactions(tx, actor, inputs),
    );

  it('writes more than one chunk, entries and all', async () => {
    // Past the batch size, so the chunk boundary is exercised rather than
    // described: a file of six hundred rows is an ordinary month for nobody,
    // and an ordinary year for plenty of people.
    const many = Array.from({ length: 600 }, (_, at) => pair(at, 'bbbb1111'));
    const written = await post(owner, many);

    expect(written).toHaveLength(600);

    const [row] = await admin<{ transactions: string; entries: string }[]>`
      SELECT count(DISTINCT t.id)::text AS transactions, count(e.id)::text AS entries
        FROM transactions t
        JOIN entries e ON e.transaction_id = t.id
       WHERE t.description LIKE 'CARTE 01/06 COMMERCE INVENTE %'`;
    expect(row?.transactions).toBe('600');
    expect(row?.entries).toBe('1200');
  });

  it('refuses the whole call when one transaction does not balance', async () => {
    // The domain's check, per transaction, before anything is written. One bad
    // row in a thousand takes the thousand with it rather than landing a
    // ledger that is nine hundred and ninety-nine parts right.
    const inputs = [
      pair(0, 'bbbb2222'),
      {
        ...pair(1, 'bbbb2222'),
        entries: [
          { accountId: current, amount: Money.of('-10.00', 'EUR') },
          { accountId: opening, amount: Money.of('9.00', 'EUR') },
        ],
      },
      pair(2, 'bbbb2222'),
    ];

    await expect(post(owner, inputs)).rejects.toThrow(UnbalancedTransactionError);

    const [row] = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM transactions
       WHERE id::text LIKE 'bbbb2222-%'`;
    expect(row?.n).toBe('0');
  });

  it('refuses an entry in a currency its account does not hold', async () => {
    // Checked for every entry of every transaction, from one query rather than
    // one per transaction. Euros in a dollar account balance perfectly against
    // each other and are silently wrong afterwards, which is why this exists.
    const inputs = [
      pair(0, 'bbbb3333'),
      {
        ...pair(1, 'bbbb3333'),
        entries: [
          { accountId: dollars, amount: Money.of('-10.00', 'EUR') },
          { accountId: opening, amount: Money.of('10.00', 'EUR') },
        ],
      },
    ];

    await expect(post(owner, inputs)).rejects.toThrow(CurrencyDoesNotMatchAccountError);

    const [row] = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM transactions WHERE id::text LIKE 'bbbb3333-%'`;
    expect(row?.n).toBe('0');
  });

  it('refuses somebody who may not record a transaction', async () => {
    // Asked once for the call rather than once per row, because the answer is
    // about the actor and cannot change between the first and the thousandth.
    await expect(post(viewer, [pair(0, 'bbbb4444')])).rejects.toThrow(ForbiddenError);
  });

  it('refuses work bound to another household than the actor', async () => {
    // The second barrier of ADR-0007, and it is the connection that is checked
    // - so asking once for the call is asking as often as it can change.
    const stranger: Actor = { userId: USER, householdId: OTHER, role: 'owner' };

    await expect(
      withHousehold(client, { householdId: HOUSE, userId: USER }, (tx) =>
        postTransactions(tx, stranger, [pair(0, 'bbbb5555')]),
      ),
    ).rejects.toThrow(TenantScopeError);
  });

  it('files every row under the household that wrote it', async () => {
    await post(owner, [pair(0, 'bbbb6666'), pair(1, 'bbbb6666')]);

    const rows = await admin<{ household_id: string }[]>`
      SELECT DISTINCT e.household_id::text
        FROM entries e
        JOIN transactions t ON t.id = e.transaction_id
       WHERE t.id::text LIKE 'bbbb6666-%'`;
    expect(rows.map((row) => row.household_id)).toEqual([HOUSE]);
  });

  it('refuses a reversal, which has to be posted on its own', async () => {
    // A reversal marks the row it cancels, and whether that row is in the same
    // batch decides the order the statements have to run in. Nothing posts one
    // in bulk, so this refuses rather than growing a case nothing exercises.
    const [original] = await post(owner, [pair(0, 'bbbb7777')]);

    await expect(
      post(owner, [{ ...pair(1, 'bbbb7777'), reversesId: original!.id }]),
    ).rejects.toThrow(/on its own/);
  });
});
