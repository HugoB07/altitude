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
  bindAccounts,
  commitImport,
  findDuplicates,
  listTransactions,
  postTransaction,
  readTradeRepublic,
  type Actor,
  type Candidate,
} from '../src/index';
import { importId as toImportId } from '@altitude/shared';

/**
 * Deduplication, against a real ledger.
 *
 * The rule this file exists to protect is asymmetric, and every case below
 * turns on it: creating a duplicate is visible and can be reversed, while
 * dropping a real movement is neither. So an identifier match is decided, and
 * everything else is only flagged.
 */

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'db', 'migrations');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
let client: Client;

const HOUSE = householdId('77777777-7777-4777-8777-777777777777');
const USER = userId('88888888-8888-4888-8888-888888888888');

let cash: AccountId;
let savings: AccountId;
let opening: AccountId;

const owner: Actor = { userId: USER, householdId: HOUSE, role: 'owner' };

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
    { id: USER, email: 'import@example.test', display_name: 'Import' },
  ])}`;
  await admin`INSERT INTO households ${admin([
    { id: HOUSE, name: 'Import', base_currency: 'EUR' },
  ])}`;
  const [portfolio] = await admin<{ id: string }[]>`
    INSERT INTO portfolios ${admin([{ household_id: HOUSE, path: 'home', name: 'Home' }])}
    RETURNING id`;
  const made = await admin<{ id: string; name: string }[]>`
    INSERT INTO accounts ${admin([
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Cash',
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
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Opening',
        kind: 'opening_balance',
        currency: 'EUR',
      },
    ])} RETURNING id, name`;
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

  cash = accountId(made.find((a) => a.name === 'Cash')!.id);
  savings = accountId(made.find((a) => a.name === 'Savings')!.id);
  opening = accountId(made.find((a) => a.name === 'Opening')!.id);

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

/** A candidate that moves `amount` from Opening into Cash on the given day. */
function candidate(day: string, amount: string, externalId?: string): Candidate {
  return {
    ...(externalId === undefined ? {} : { externalId }),
    bookedOn: ledgerDate(day),
    kind: 'deposit',
    sourceLines: [2],
    entries: [
      { account: 'CASH', amount, currency: 'EUR' },
      { account: 'OPENING', amount: `-${amount}`, currency: 'EUR' },
    ],
  };
}

const binding = () => ({ CASH: cash, OPENING: opening, SAVINGS: savings });

describe('bindAccounts', () => {
  it('replaces every label with the account chosen for it', () => {
    const { bound, problems } = bindAccounts([candidate('2026-03-01', '10')], binding());
    expect(problems).toEqual([]);
    expect(bound[0]?.entries.map((e) => e.accountId)).toEqual([cash, opening]);
    // The label survives, because the preview shows what the file called it.
    expect(bound[0]?.entries[0]?.label).toBe('CASH');
  });

  it('sets aside a candidate with an unbound label rather than guessing', () => {
    const { bound, problems } = bindAccounts([candidate('2026-03-01', '10')], { CASH: cash });
    expect(bound).toEqual([]);
    expect(problems[0]?.reason).toContain('OPENING');
  });

  /**
   * The counterpart is a question per transaction, not per file.
   *
   * `OPENING` here stands for what a bank export calls the outside world. One
   * answer for the whole file puts a salary and a transfer from your own
   * account at another bank into the same account, and nothing on any screen
   * afterwards shows that the two were ever different.
   */
  it('lets one transaction answer differently from the rest of the file', () => {
    const salary = candidate('2026-03-01', '2000');
    const fromElsewhere = candidate('2026-03-02', '500');

    const { bound, problems } = bindAccounts([salary, fromElsewhere], binding(), {
      1: { OPENING: savings },
    });

    expect(problems).toEqual([]);
    expect(bound[0]?.entries.map((e) => e.accountId)).toEqual([cash, opening]);
    expect(bound[1]?.entries.map((e) => e.accountId)).toEqual([cash, savings]);
  });

  it('an override for a label the candidate does not mention changes nothing', () => {
    const { bound, problems } = bindAccounts([candidate('2026-03-01', '10')], binding(), {
      0: { NOWHERE: savings },
    });
    expect(problems).toEqual([]);
    expect(bound[0]?.entries.map((e) => e.accountId)).toEqual([cash, opening]);
  });

  it('still refuses to guess when only some rows were answered', () => {
    const { bound, problems } = bindAccounts(
      [candidate('2026-03-01', '10'), candidate('2026-03-02', '20')],
      { CASH: cash },
      { 0: { OPENING: opening } },
    );
    expect(bound).toHaveLength(1);
    expect(problems[0]?.reason).toContain('OPENING');
  });
});

describe('findDuplicates', () => {
  it('says nothing is a duplicate when the ledger is empty', async () => {
    const { bound } = bindAccounts([candidate('2026-03-01', '10')], binding());
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));
    expect(verdicts).toEqual([{ kind: 'new' }]);
  });

  it('recognises a transaction by the identifier the provider gave it', async () => {
    const id = transactionId('99999999-0000-4000-8000-000000000001');
    await scoped((tx) =>
      postTransaction(tx, owner, {
        id,
        bookedOn: ledgerDate('2026-03-02'),
        kind: 'deposit',
        externalId: 'tr-abc-123',
        entries: [
          { accountId: cash, amount: Money.of('25', 'EUR') },
          { accountId: opening, amount: Money.of('-25', 'EUR') },
        ],
      }),
    );

    const { bound } = bindAccounts([candidate('2026-03-02', '25', 'tr-abc-123')], binding());
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));

    // Decided, not flagged: the identifier is unique per household, so there is
    // nothing left for a person to judge.
    expect(verdicts[0]).toEqual({ kind: 'certain', existing: id });
  });

  it('flags a look-alike rather than deciding, when there is no identifier', async () => {
    const { bound } = bindAccounts([candidate('2026-03-02', '25')], binding());
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));

    // Same day, same accounts, same amount - and still only probable, because a
    // person may genuinely have done it twice.
    expect(verdicts[0]?.kind).toBe('probable');
  });

  /**
   * The case the whole design turns on.
   *
   * Two identical movements in the file against one in the ledger means one was
   * already imported and one is new. Marking both as duplicates would drop a
   * real transaction, and a balance quietly short by twenty-five euros is
   * exactly the failure nobody notices until it is months old.
   */
  it('consumes each match once, so a real repeat survives', async () => {
    const { bound } = bindAccounts(
      [candidate('2026-03-02', '25'), candidate('2026-03-02', '25')],
      binding(),
    );
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));

    expect(verdicts.map((v) => v.kind)).toEqual(['probable', 'new']);
  });

  it('does not match across days or amounts', async () => {
    const { bound } = bindAccounts(
      [candidate('2026-03-03', '25'), candidate('2026-03-02', '26')],
      binding(),
    );
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));
    expect(verdicts.map((v) => v.kind)).toEqual(['new', 'new']);
  });

  /**
   * The comparison has to survive the database's own formatting.
   *
   * `amount` is numeric(28,10), so the stored value reads back as
   * "25.0000000000" while a file writes "25". Comparing those as text finds
   * nothing, and finds it silently - deduplication that never matches looks
   * exactly like deduplication that has nothing to match.
   */
  it('matches a value written with trailing zeros', async () => {
    const { bound } = bindAccounts([candidate('2026-03-02', '25.0000')], binding());
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));
    expect(verdicts[0]?.kind).toBe('probable');
  });

  it('refuses an actor from another household', async () => {
    const stranger: Actor = {
      userId: USER,
      householdId: householdId('66666666-6666-4666-8666-666666666666'),
      role: 'owner',
    };
    const { bound } = bindAccounts([candidate('2026-03-01', '10')], binding());
    await expect(scoped((tx) => findDuplicates(tx, stranger, bound))).rejects.toThrow();
  });
});

/**
 * The whole chain, on the shape of a real broker export.
 *
 * Read, bind, deduplicate, write - then do it again with the same file, which
 * is what a person actually does two weeks later when they export a period that
 * overlaps the last one.
 */
describe('an import, end to end', () => {
  const HEADER = [
    'datetime',
    'date',
    'account_type',
    'category',
    'type',
    'asset_class',
    'name',
    'symbol',
    'shares',
    'price',
    'amount',
    'fee',
    'tax',
    'currency',
    'original_amount',
    'original_currency',
    'fx_rate',
    'description',
    'transaction_id',
    'counterparty_name',
    'counterparty_iban',
    'payment_reference',
    'mcc_code',
  ].join(';');

  const rowOf = (fields: Record<string, string>) =>
    HEADER.split(';')
      .map((name) => fields[name] ?? '')
      .join(';');

  const FILE = [
    HEADER,
    rowOf({
      date: '2026-04-01'.split('-').reverse().join('/'),
      account_type: 'CASH',
      type: 'TRANSFER_INSTANT_INBOUND',
      amount: '300.000000',
      currency: 'EUR',
      description: 'Salary',
      transaction_id: 'tr-1',
    }),
    rowOf({
      date: '02/04/2026',
      account_type: 'CASH',
      type: 'TRANSFER_OUT',
      amount: '-120.00',
      currency: 'EUR',
      description: 'To savings',
      transaction_id: 'tr-2',
    }),
    rowOf({
      date: '02/04/2026',
      account_type: 'SAVINGS',
      type: 'TRANSFER_IN',
      amount: '120.00',
      currency: 'EUR',
      description: 'To savings',
      transaction_id: 'tr-3',
    }),
    '',
  ].join(String.fromCharCode(10));

  async function run(file: string, ids: string[]) {
    const reading = readTradeRepublic(file);
    const { bound } = bindAccounts(reading.candidates, {
      CASH: cash,
      SAVINGS: savings,
      EXTERNAL: opening,
    });
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));

    // Only what is not already there. `certain` is decided; `probable` would be
    // a question for a person, and this file carries identifiers so none arise.
    const keep = bound.filter((_, i) => verdicts[i]?.kind === 'new');

    if (keep.length > 0) {
      await scoped((tx) =>
        commitImport(tx, owner, {
          importId: toImportId(ids[0]!),
          source: 'trade-republic',
          filename: 'export.csv',
          candidates: keep,
          transactionIds: keep.map((_, i) => transactionId(ids[i + 1]!)),
        }),
      );
    }
    return { verdicts, written: keep.length };
  }

  it('writes what the file says, once', async () => {
    const first = await run(FILE, [
      'aaaaaaaa-1111-4000-8000-000000000000',
      'aaaaaaaa-1111-4000-8000-000000000001',
      'aaaaaaaa-1111-4000-8000-000000000002',
    ]);

    expect(first.written).toBe(2);

    const page = await scoped((tx) =>
      listTransactions(tx, owner, {
        perPage: 50,
        from: ledgerDate('2026-04-01'),
        to: ledgerDate('2026-04-30'),
      }),
    );
    expect(page.total).toBe(2);

    // The transfer is one transaction with both sides, not two halves needing a
    // counterpart invented for each.
    const transfer = page.transactions.find((e) => e.description === 'To savings');
    expect(transfer?.lines).toHaveLength(2);
    expect(transfer?.lines.map((l) => l.accountId).sort()).toEqual([cash, savings].sort());

    // And money from outside got the counterpart the preview chose for it.
    const salary = page.transactions.find((e) => e.description === 'Salary');
    expect(salary?.lines.some((l) => l.accountId === opening)).toBe(true);
  });

  it('adds nothing when the same file is imported again', async () => {
    const second = await run(FILE, [
      'bbbbbbbb-1111-4000-8000-000000000000',
      'bbbbbbbb-1111-4000-8000-000000000001',
      'bbbbbbbb-1111-4000-8000-000000000002',
    ]);

    // Every candidate is recognised by the identifier the provider gave it, so
    // nothing is written and nothing had to be judged.
    expect(second.verdicts.every((v) => v.kind === 'certain')).toBe(true);
    expect(second.written).toBe(0);

    const page = await scoped((tx) =>
      listTransactions(tx, owner, {
        perPage: 50,
        from: ledgerDate('2026-04-01'),
        to: ledgerDate('2026-04-30'),
      }),
    );
    expect(page.total).toBe(2);
  });

  it('records which import wrote each row, so undoing one is possible', async () => {
    const [row] = await admin<{ import_id: string | null; source: string }[]>`
      SELECT import_id, source FROM transactions
       WHERE description = 'Salary' AND household_id = ${HOUSE}`;
    expect(row?.import_id).toBe('aaaaaaaa-1111-4000-8000-000000000000');
    expect(row?.source).toBe('import');

    const [batch] = await admin<{ filename: string; source: string }[]>`
      SELECT filename, source FROM imports WHERE household_id = ${HOUSE}`;
    expect(batch?.filename).toBe('export.csv');
    expect(batch?.source).toBe('trade-republic');
  });
});
