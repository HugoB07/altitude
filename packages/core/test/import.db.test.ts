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
  ImportAlreadyRolledBackError,
  ImportNotFoundError,
  accountBalances,
  bindAccounts,
  commitImport,
  findDuplicates,
  findImportsOfFile,
  listImports,
  listTransactions,
  postTransaction,
  readTradeRepublic,
  rollbackImport,
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

/** The same, with the text a statement writes on the line. */
function described(day: string, amount: string, description: string): Candidate {
  return { ...candidate(day, amount), description };
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
    // nothing left for a person to judge. The verdict hands back the whole
    // transaction, which is what putting the two side by side needs.
    expect(verdicts[0]?.kind).toBe('certain');
    expect(verdicts[0]).toMatchObject({
      existing: { id, bookedOn: '2026-03-02', entries: expect.anything() },
    });
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

  /**
   * The defect the wider window exists for.
   *
   * A bank re-exporting a month does not always write the same date for a
   * line - the operation date one time, the value date the next. On an exact
   * date match that came back as new, and a person ended up with the same
   * direct debit twice, which nobody notices until the balance is months wrong.
   */
  it('matches a line the bank moved by two days, when the description agrees', async () => {
    await scoped((tx) =>
      postTransaction(tx, owner, {
        id: transactionId('99999999-0000-4000-8000-000000000010'),
        bookedOn: ledgerDate('2026-09-10'),
        kind: 'withdrawal',
        description: 'PRLV SEPA ASSURANCE HABITATION 87654321',
        entries: [
          { accountId: cash, amount: Money.of('31.20', 'EUR') },
          { accountId: opening, amount: Money.of('-31.20', 'EUR') },
        ],
      }),
    );

    const { bound } = bindAccounts(
      [described('2026-09-12', '31.20', 'PRLV SEPA ASSURANCE HABITATION')],
      binding(),
    );
    const [verdict] = (await scoped((tx) => findDuplicates(tx, owner, bound))).verdicts;

    expect(verdict?.kind).toBe('probable');
    // Carried so the screen can say why, which on a date that does not match
    // is the difference between a warning and a riddle.
    expect(verdict).toMatchObject({ daysApart: 2 });
    expect(verdict && 'similarity' in verdict ? verdict.similarity : 0).toBeGreaterThan(0.7);
  });

  it('leaves a nearby line alone when the descriptions disagree', async () => {
    const { bound } = bindAccounts(
      [described('2026-09-12', '31.20', 'CARTE BOULANGERIE DU PARC')],
      binding(),
    );
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));
    expect(verdicts[0]?.kind).toBe('new');
  });

  it('leaves a nearby line alone when there is nothing to weigh', async () => {
    // No description on the candidate. Two debits of the same amount two days
    // apart are an ordinary thing to have done, and guessing here would be the
    // failure the whole design refuses.
    const { bound } = bindAccounts([candidate('2026-09-12', '31.20')], binding());
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));
    expect(verdicts[0]?.kind).toBe('new');
  });

  it('stops at the edge of the window, however alike the wording', async () => {
    const { bound } = bindAccounts(
      [described('2026-09-14', '31.20', 'PRLV SEPA ASSURANCE HABITATION 87654321')],
      binding(),
    );
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bound));
    expect(verdicts[0]?.kind).toBe('new');
  });

  it('takes the line on the same day over the one nearby', async () => {
    const onTheDay = transactionId('99999999-0000-4000-8000-000000000011');
    await scoped((tx) =>
      postTransaction(tx, owner, {
        id: onTheDay,
        bookedOn: ledgerDate('2026-09-12'),
        kind: 'withdrawal',
        description: 'PRLV SEPA ASSURANCE HABITATION 87654321',
        entries: [
          { accountId: cash, amount: Money.of('31.20', 'EUR') },
          { accountId: opening, amount: Money.of('-31.20', 'EUR') },
        ],
      }),
    );

    const { bound } = bindAccounts(
      [described('2026-09-12', '31.20', 'PRLV SEPA ASSURANCE HABITATION')],
      binding(),
    );
    const [verdict] = (await scoped((tx) => findDuplicates(tx, owner, bound))).verdicts;

    // The row two days earlier is still unconsumed and would have matched. A
    // date that agrees beats a date that is merely close.
    expect(verdict).toMatchObject({
      kind: 'probable',
      existing: { id: onTheDay },
      daysApart: 0,
    });
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

describe('rolling an import back', () => {
  const HEADER_R = [
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

  const row = (fields: Record<string, string>) =>
    HEADER_R.split(';')
      .map((name) => fields[name] ?? '')
      .join(';');

  /** Two movements from outside, so the reversal has something to cancel. */
  const FILE_R = [
    HEADER_R,
    row({
      date: '05/06/2026',
      account_type: 'CASH',
      type: 'TRANSFER_INSTANT_INBOUND',
      amount: '80.00',
      currency: 'EUR',
      description: 'Rollback one',
      transaction_id: 'rb-1',
    }),
    row({
      date: '06/06/2026',
      account_type: 'CASH',
      type: 'TRANSFER_INSTANT_INBOUND',
      amount: '20.00',
      currency: 'EUR',
      description: 'Rollback two',
      transaction_id: 'rb-2',
    }),
    '',
  ].join(String.fromCharCode(10));

  const BATCH = toImportId('cccccccc-2222-4000-8000-000000000000');

  async function balanceOfCash() {
    const balances = await scoped((tx) => accountBalances(tx, owner));
    return balances.find((b) => b.accountId === cash)?.balance.amount.toFixed();
  }

  it('undoes every transaction the run made, without deleting any', async () => {
    const reading = readTradeRepublic(FILE_R);
    const { bound } = bindAccounts(reading.candidates, {
      CASH: cash,
      SAVINGS: savings,
      EXTERNAL: opening,
    });

    const before = await balanceOfCash();

    await scoped((tx) =>
      commitImport(tx, owner, {
        importId: BATCH,
        source: 'trade-republic',
        filename: 'rollback.csv',
        candidates: bound,
        transactionIds: [
          transactionId('cccccccc-2222-4000-8000-000000000001'),
          transactionId('cccccccc-2222-4000-8000-000000000002'),
        ],
      }),
    );

    expect(await balanceOfCash()).not.toBe(before);

    const result = await scoped((tx) =>
      rollbackImport(tx, owner, {
        importId: BATCH,
        on: ledgerDate('2026-06-30'),
        reversalIds: [
          transactionId('cccccccc-2222-4000-8000-000000000011'),
          transactionId('cccccccc-2222-4000-8000-000000000012'),
        ],
      }),
    );

    expect(result.reversed).toBe(2);
    expect(result.skipped).toBe(0);
    // Back where it started, and by arithmetic rather than by deletion.
    expect(await balanceOfCash()).toBe(before);

    // Four transactions now, not zero: the two the file made and the two that
    // cancelled them. A ledger that erased them is the ledger ADR-0002 exists
    // to avoid, and it is also the one that cannot answer "what happened".
    const page = await scoped((tx) =>
      listTransactions(tx, owner, {
        perPage: 50,
        from: ledgerDate('2026-06-01'),
        to: ledgerDate('2026-06-30'),
      }),
    );
    expect(page.total).toBe(4);
  });

  it('refuses to undo the same run twice', async () => {
    await expect(
      scoped((tx) =>
        rollbackImport(tx, owner, {
          importId: BATCH,
          on: ledgerDate('2026-06-30'),
          reversalIds: [transactionId('cccccccc-2222-4000-8000-000000000021')],
        }),
      ),
    ).rejects.toThrow(ImportAlreadyRolledBackError);
  });

  it('refuses a run this household does not have', async () => {
    await expect(
      scoped((tx) =>
        rollbackImport(tx, owner, {
          importId: toImportId('dddddddd-2222-4000-8000-000000000000'),
          on: ledgerDate('2026-06-30'),
          reversalIds: [],
        }),
      ),
    ).rejects.toThrow(ImportNotFoundError);
  });

  it('lists the run as undone, and still counts what it wrote', async () => {
    const runs = await scoped((tx) => listImports(tx, owner));
    const batch = runs.find((r) => r.id === BATCH);

    expect(batch?.filename).toBe('rollback.csv');
    expect(batch?.rolledBackAt).not.toBeNull();

    // Dates, not the strings raw SQL hands back. Annotating the row type `Date`
    // compiled and threw at the first render of the screen, and this assertion
    // is what would have caught it here instead.
    expect(batch?.createdAt).toBeInstanceOf(Date);
    expect(batch?.rolledBackAt).toBeInstanceOf(Date);
    // The transactions it made are still its own, reversed or not. A count that
    // dropped to zero would make an undone import indistinguishable from an
    // empty one.
    expect(batch?.transactions).toBe(2);
  });
});

describe('a file can be imported again after its import is undone', () => {
  /**
   * The promise the undo dialog makes, and the reason it was not true.
   *
   * `transactions_external_id_key` is what makes a second import of the same
   * file add nothing. After a rollback, the cancelled originals still held
   * every provider id, so re-importing collided with transactions that no
   * longer counted for anything - reported as "an error occurred", which is all
   * a unique-violation says to a person.
   */
  const HEADER_A = [
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

  const line = (fields: Record<string, string>) =>
    HEADER_A.split(';')
      .map((name) => fields[name] ?? '')
      .join(';');

  const FILE_A = [
    HEADER_A,
    line({
      date: '10/09/2026',
      account_type: 'CASH',
      type: 'TRANSFER_INSTANT_INBOUND',
      amount: '42.00',
      currency: 'EUR',
      description: 'Again one',
      transaction_id: 'again-1',
    }),
    '',
  ].join(String.fromCharCode(10));

  const bind = () => {
    const reading = readTradeRepublic(FILE_A);
    return bindAccounts(reading.candidates, { CASH: cash, EXTERNAL: opening }).bound;
  };

  it('imports, undoes, and imports the same file again', async () => {
    const first = toImportId('eeeeeeee-3333-4000-8000-000000000001');
    await scoped((tx) =>
      commitImport(tx, owner, {
        importId: first,
        source: 'trade-republic',
        filename: 'again.csv',
        candidates: bind(),
        transactionIds: [transactionId('eeeeeeee-3333-4000-8000-000000000011')],
      }),
    );

    await scoped((tx) =>
      rollbackImport(tx, owner, {
        importId: first,
        on: ledgerDate('2026-09-30'),
        reversalIds: [transactionId('eeeeeeee-3333-4000-8000-000000000012')],
      }),
    );

    // The cancelled original is no longer a match, so the row is offered again
    // rather than reported as already imported.
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bind()));
    expect(verdicts[0]?.kind).toBe('new');

    // And it writes, which the unique index used to refuse.
    const second = toImportId('eeeeeeee-3333-4000-8000-000000000002');
    await expect(
      scoped((tx) =>
        commitImport(tx, owner, {
          importId: second,
          source: 'trade-republic',
          filename: 'again.csv',
          candidates: bind(),
          transactionIds: [transactionId('eeeeeeee-3333-4000-8000-000000000021')],
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('still refuses a third copy while the second one stands', async () => {
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, bind()));
    expect(verdicts[0]?.kind).toBe('certain');
  });
});

/**
 * The exact level of the plan (§8.5), for the statements that carry no
 * identifier of their own - which is most French ones.
 *
 * Without it, re-importing a file was a page of look-alikes to walk through
 * every time. With it the import writes what it read, and reading the same
 * thing again is decided rather than asked about.
 */
describe('a file the bank gives no identifiers for', () => {
  const RUN = toImportId('ffffffff-4444-4000-8000-000000000001');
  const lines = () =>
    bindAccounts(
      [
        described('2026-12-03', '54.90', 'CARTE 03/12 BOULANGERIE DU PARC 4972'),
        described('2026-12-04', '18.30', 'CARTE 04/12 PHARMACIE DE LA GARE 4972'),
      ],
      binding(),
    ).bound;

  it('is recognised outright the second time, by the hash the import wrote', async () => {
    await scoped((tx) =>
      commitImport(tx, owner, {
        importId: RUN,
        source: 'other',
        filename: 'decembre.csv',
        candidates: lines(),
        transactionIds: [
          transactionId('ffffffff-4444-4000-8000-000000000011'),
          transactionId('ffffffff-4444-4000-8000-000000000012'),
        ],
      }),
    );

    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, lines()));
    expect(verdicts.map((v) => v.kind)).toEqual(['certain', 'certain']);
  });

  it('survives the bank rewriting the date and the card number in the text', async () => {
    // The same two lines as a re-export writes them: the embedded date moved
    // with nothing else, which is exactly what `normaliseLabel` takes out
    // before the hash is taken.
    const rewritten = bindAccounts(
      [
        described('2026-12-03', '54.90', 'CARTE 05/12 BOULANGERIE DU PARC 4972'),
        described('2026-12-04', '18.30', 'CARTE 06/12 PHARMACIE DE LA GARE 4972'),
      ],
      binding(),
    ).bound;

    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, rewritten));
    expect(verdicts.map((v) => v.kind)).toEqual(['certain', 'certain']);
  });
});

describe('merging a look-alike into what is already there', () => {
  const RUN = toImportId('ffffffff-4444-4000-8000-000000000002');
  const existing = transactionId('ffffffff-4444-4000-8000-000000000021');

  it('gives the existing transaction the line hash, and posts nothing', async () => {
    // Typed by hand, so it carries no hash and no identifier: the case where
    // "keep both" and "skip" are both wrong, because the movement is real and
    // already recorded.
    await scoped((tx) =>
      postTransaction(tx, owner, {
        id: existing,
        bookedOn: ledgerDate('2026-12-20'),
        kind: 'withdrawal',
        description: 'Chauffagiste',
        entries: [
          { accountId: cash, amount: Money.of('120', 'EUR') },
          { accountId: opening, amount: Money.of('-120', 'EUR') },
        ],
      }),
    );

    const line = bindAccounts(
      [described('2026-12-20', '120', 'VIR 87654321 CHAUFFAGISTE')],
      binding(),
    ).bound;

    const result = await scoped((tx) =>
      commitImport(tx, owner, {
        importId: RUN,
        source: 'other',
        filename: 'decembre.csv',
        candidates: [],
        transactionIds: [],
        merges: [{ existing, line: line[0]! }],
      }),
    );

    expect(result.written).toBe(0);
    expect(result.merged).toBe(1);

    // And the same line, read again, is now decided rather than asked about.
    const { verdicts } = await scoped((tx) => findDuplicates(tx, owner, line));
    expect(verdicts[0]).toMatchObject({ kind: 'certain', existing: { id: existing } });
  });

  it('adds a second way of writing the same movement rather than replacing the first', async () => {
    // Another bank's export of the same payment, worded its own way. Both
    // wordings now belong to this transaction: a single stored key would make
    // the two files take turns overwriting each other, and each import would
    // ask about the same movement again.
    const other = bindAccounts(
      [described('2026-12-20', '120', 'VIREMENT PLOMBIER')],
      binding(),
    ).bound;

    const again = () =>
      scoped((tx) =>
        commitImport(tx, owner, {
          importId: toImportId('ffffffff-4444-4000-8000-000000000003'),
          source: 'other',
          filename: 'autre.csv',
          candidates: [],
          transactionIds: [],
          merges: [{ existing, line: other[0]! }],
        }),
      );

    expect((await again()).merged).toBe(1);

    // Both are recognised, neither having displaced the other.
    const first = bindAccounts(
      [described('2026-12-20', '120', 'VIR 87654321 CHAUFFAGISTE')],
      binding(),
    ).bound;
    expect((await scoped((tx) => findDuplicates(tx, owner, first))).verdicts[0]?.kind).toBe(
      'certain',
    );
    expect((await scoped((tx) => findDuplicates(tx, owner, other))).verdicts[0]?.kind).toBe(
      'certain',
    );
  });
});

/**
 * What an import keeps about the file it read, which is not the file.
 *
 * The plan asks for the raw statement to be archived (§8.2, step 1). That
 * document holds an IBAN, an account holder's name and every operation of the
 * period, including the ones nobody imported - so this keeps a digest instead,
 * and answers the question people actually ask with it.
 */
describe('recognising a file that was imported before', () => {
  const RUN = toImportId('aaaa6666-0000-4000-8000-000000000001');
  const FILE = ['Date;Libelle;Montant', '05/01/2027;Loyer janvier;-750,00', ''].join('\n');

  it('finds nothing before anything has been imported', async () => {
    expect(await scoped((tx) => findImportsOfFile(tx, owner, FILE))).toEqual([]);
  });

  it('recognises the same file afterwards, and says when', async () => {
    await scoped((tx) =>
      commitImport(tx, owner, {
        importId: RUN,
        source: 'other',
        filename: 'janvier.csv',
        text: FILE,
        candidates: bindAccounts([candidate('2027-01-05', '750')], binding()).bound,
        transactionIds: [transactionId('aaaa6666-0000-4000-8000-000000000011')],
      }),
    );

    const seen = await scoped((tx) => findImportsOfFile(tx, owner, FILE));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.filename).toBe('janvier.csv');
    expect(seen[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('does not recognise a different file', async () => {
    const other = FILE.replace('Loyer janvier', 'Loyer fevrier');
    expect(await scoped((tx) => findImportsOfFile(tx, owner, other))).toEqual([]);
  });

  it('forgets a run that was rolled back, because it added nothing in the end', async () => {
    await scoped((tx) =>
      rollbackImport(tx, owner, {
        importId: RUN,
        on: ledgerDate('2027-01-31'),
        reversalIds: [transactionId('aaaa6666-0000-4000-8000-000000000021')],
      }),
    );

    expect(await scoped((tx) => findImportsOfFile(tx, owner, FILE))).toEqual([]);
  });
});
