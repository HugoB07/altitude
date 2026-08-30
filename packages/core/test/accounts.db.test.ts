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
  AccountNotEmptyError,
  AccountNotFoundError,
  CREATABLE_KINDS,
  ForbiddenError,
  InvalidAccountError,
  accountBalances,
  closeAccount,
  createAccount,
  postTransaction,
  renameAccount,
  reopenAccount,
  type Actor,
} from '../src/index';

/**
 * Account management against a real database.
 *
 * The rules worth having a container for are the ones the database is party to:
 * that a name lands where row-level security can see it, that an id from
 * another household matches nothing rather than something, and that closing an
 * account reads its balance in the same transaction that closes it.
 */

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'db', 'migrations');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
let client: Client;

const HOUSE = householdId('44444444-4444-4444-8444-444444444444');
const OTHER = householdId('55555555-5555-4555-8555-555555555555');
const USER = userId('66666666-6666-4666-8666-666666666666');

let openingId: AccountId;
let elsewhere: AccountId;

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
    { id: USER, email: 'claire@example.test', display_name: 'Claire' },
  ])}`;
  await admin`INSERT INTO households ${admin([
    { id: HOUSE, name: 'Vasseur', base_currency: 'EUR' },
    { id: OTHER, name: 'Elsewhere', base_currency: 'EUR' },
  ])}`;

  const [home] = await admin<{ id: string }[]>`
    INSERT INTO portfolios ${admin([{ household_id: HOUSE, path: 'home', name: 'Home' }])}
    RETURNING id`;
  const [away] = await admin<{ id: string }[]>`
    INSERT INTO portfolios ${admin([{ household_id: OTHER, path: 'home', name: 'Away' }])}
    RETURNING id`;

  const [openingRow] = await admin<{ id: string }[]>`
    INSERT INTO accounts ${admin([
      {
        household_id: HOUSE,
        portfolio_id: home!.id,
        name: 'Opening',
        kind: 'opening_balance',
        currency: 'EUR',
      },
    ])} RETURNING id`;

  // An account in the other household, to aim cross-tenant calls at.
  const [awayRow] = await admin<{ id: string }[]>`
    INSERT INTO accounts ${admin([
      {
        household_id: OTHER,
        portfolio_id: away!.id,
        name: 'Not yours',
        kind: 'cash',
        currency: 'EUR',
      },
    ])} RETURNING id`;
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

  openingId = accountId(openingRow!.id);
  elsewhere = accountId(awayRow!.id);

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

const scoped = <T>(work: (tx: Parameters<Parameters<typeof withHousehold>[2]>[0]) => Promise<T>) =>
  withHousehold(client, { householdId: HOUSE, userId: USER }, work);

describe('createAccount', () => {
  it('creates an account and shows it at zero', async () => {
    const { id } = await scoped((tx) =>
      createAccount(tx, owner, { name: '  Livret   A ', kind: 'savings', currency: 'EUR' }),
    );

    const balances = await scoped((tx) => accountBalances(tx, owner));
    const made = balances.find((b) => b.accountId === id);

    // Whitespace collapsed rather than rejected: someone pasting a name from a
    // bank statement should not have to notice the double space.
    expect(made?.name).toBe('Livret A');
    expect(made?.classification).toBe('asset');
    expect(made?.balance.amount.toFixed()).toBe('0');
    expect(made?.closedOn).toBeNull();
  });

  it('classifies a loan as debt without being told to', async () => {
    const { id } = await scoped((tx) =>
      createAccount(tx, owner, { name: 'Mortgage', kind: 'loan', currency: 'EUR' }),
    );
    const balances = await scoped((tx) => accountBalances(tx, owner));
    expect(balances.find((b) => b.accountId === id)?.classification).toBe('liability');
  });

  it('refuses a viewer', async () => {
    await expect(
      scoped((tx) => createAccount(tx, viewer, { name: 'X', kind: 'cash', currency: 'EUR' })),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a blank name', async () => {
    await expect(
      scoped((tx) => createAccount(tx, owner, { name: '   ', kind: 'cash', currency: 'EUR' })),
    ).rejects.toThrow(InvalidAccountError);
  });

  it('refuses a second opening balance account', async () => {
    // One per household, made at setup. A second would balance nothing extra.
    expect(CREATABLE_KINDS).not.toContain('opening_balance');
    await expect(
      scoped((tx) =>
        createAccount(tx, owner, { name: 'Opening 2', kind: 'opening_balance', currency: 'EUR' }),
      ),
    ).rejects.toThrow(InvalidAccountError);
  });

  it('refuses a currency that is not shaped like one', async () => {
    await expect(
      scoped((tx) => createAccount(tx, owner, { name: 'X', kind: 'cash', currency: '€' })),
    ).rejects.toThrow();

    // "EURO" is accepted, and that is not a gap to close here. The validator
    // takes three to ten letters because crypto tickers are longer than three -
    // USDT, MATIC, DOGE - so a four-letter typo is indistinguishable from a
    // legitimate ticker without a whitelist that would reject real assets.
    // Catching it needs a currency table, which is phase 3.
    await expect(
      scoped((tx) => createAccount(tx, owner, { name: 'Typo', kind: 'cash', currency: 'EURO' })),
    ).resolves.toBeDefined();
  });
});

describe('renameAccount', () => {
  it('renames', async () => {
    const { id } = await scoped((tx) =>
      createAccount(tx, owner, { name: 'Old', kind: 'cash', currency: 'EUR' }),
    );
    await scoped((tx) => renameAccount(tx, owner, id, 'New'));

    const balances = await scoped((tx) => accountBalances(tx, owner));
    expect(balances.find((b) => b.accountId === id)?.name).toBe('New');
  });

  it('cannot reach an account in another household', async () => {
    // Row-level security makes the UPDATE match no row, so this is a not-found
    // rather than a permission error - and deliberately reads the same as an id
    // that never existed.
    await expect(scoped((tx) => renameAccount(tx, owner, elsewhere, 'Mine now'))).rejects.toThrow(
      AccountNotFoundError,
    );

    const [row] = await admin<{ name: string }[]>`
      SELECT name FROM accounts WHERE id = ${elsewhere}`;
    expect(row?.name).toBe('Not yours');
  });
});

describe('closeAccount', () => {
  it('closes an empty account and hides nothing', async () => {
    const { id } = await scoped((tx) =>
      createAccount(tx, owner, { name: 'Unused', kind: 'cash', currency: 'EUR' }),
    );
    await scoped((tx) => closeAccount(tx, owner, id, ledgerDate('2026-08-30')));

    const balances = await scoped((tx) => accountBalances(tx, owner));
    expect(balances.find((b) => b.accountId === id)?.closedOn).toBe('2026-08-30');
  });

  /**
   * The rule that makes closing safe.
   *
   * A closed account is out of sight, so closing one that still holds money
   * would take real money off the screen while leaving it in the ledger. That
   * is the same shape as the net worth bug: a total wrong in a direction nobody
   * checks.
   */
  it('refuses to close an account that still holds money', async () => {
    const { id } = await scoped((tx) =>
      createAccount(tx, owner, { name: 'Holds money', kind: 'cash', currency: 'EUR' }),
    );

    await scoped((tx) =>
      postTransaction(tx, owner, {
        id: transactionId('bbbbbbbb-0000-4000-8000-000000000001'),
        bookedOn: ledgerDate('2026-03-01'),
        kind: 'deposit',
        entries: [
          { accountId: id, amount: Money.of('250', 'EUR') },
          { accountId: openingId, amount: Money.of('-250', 'EUR') },
        ],
      }),
    );

    await expect(
      scoped((tx) => closeAccount(tx, owner, id, ledgerDate('2026-08-30'))),
    ).rejects.toThrow(AccountNotEmptyError);

    const balances = await scoped((tx) => accountBalances(tx, owner));
    expect(balances.find((b) => b.accountId === id)?.closedOn).toBeNull();
  });

  it('closes it once the balance is moved out', async () => {
    const balancesBefore = await scoped((tx) => accountBalances(tx, owner));
    const holding = balancesBefore.find((b) => b.name === 'Holds money')!;

    await scoped((tx) =>
      postTransaction(tx, owner, {
        id: transactionId('bbbbbbbb-0000-4000-8000-000000000002'),
        bookedOn: ledgerDate('2026-03-02'),
        kind: 'transfer',
        entries: [
          { accountId: holding.accountId, amount: Money.of('-250', 'EUR') },
          { accountId: openingId, amount: Money.of('250', 'EUR') },
        ],
      }),
    );

    await scoped((tx) => closeAccount(tx, owner, holding.accountId, ledgerDate('2026-08-30')));

    const after = await scoped((tx) => accountBalances(tx, owner));
    expect(after.find((b) => b.accountId === holding.accountId)?.closedOn).toBe('2026-08-30');
  });

  it('reopens', async () => {
    const balances = await scoped((tx) => accountBalances(tx, owner));
    const closed = balances.find((b) => b.name === 'Unused')!;

    await scoped((tx) => reopenAccount(tx, owner, closed.accountId));

    const after = await scoped((tx) => accountBalances(tx, owner));
    expect(after.find((b) => b.accountId === closed.accountId)?.closedOn).toBeNull();
  });
});
