import { eq, inArray, sql } from 'drizzle-orm';
import {
  accounts as accountsTable,
  entries as entriesTable,
  transactions as transactionsTable,
  transactionsDedupeKeys as dedupeKeys,
} from '@altitude/db';
import type { AccountClass, Database } from '@altitude/db';
import {
  Money,
  dec,
  instrumentId,
  type AccountId,
  type LedgerDate,
  type TransactionId,
} from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
import { assertActorMatchesTenant, TenantScopeError } from './tenant';

// Re-exported so the move out of this file is invisible to importers.
export { TenantScopeError };
import { createTransaction, reverseTransaction } from '../ledger/create-transaction';
import type { Transaction, TransactionInput } from '../ledger/types';

/**
 * The service layer both Server Actions and Route Handlers call (ADR-0005).
 *
 * Every function takes a transaction handle rather than opening one, so the
 * tenant binding stays at the edge where the session is. The caller wraps these
 * in `scoped()`; a service that could open its own connection would be a
 * service that could forget which household it is acting for.
 */

export interface PostTransactionResult {
  readonly transaction: Transaction;
  readonly id: TransactionId;
}

/**
 * Validates a transaction, checks the actor may post it, and writes it.
 *
 * Authorise, then validate, then persist - in that order, everywhere.
 *
 * Authorisation first because a refusal must not depend on whether the input
 * was well formed: otherwise the error tells someone who may not act here what
 * the system thinks of their data.
 *
 * Validation is `createTransaction` from the domain - the same function the
 * unit tests exercise, so the rule enforced here is the rule those tests
 * describe. The database enforces it again (ADR-0002). Neither is redundant:
 * each covers a path the other does not.
 */
export async function postTransaction(
  tx: Database,
  actor: Actor,
  input: TransactionInput,
): Promise<PostTransactionResult> {
  assertCan(actor, 'transaction:create', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const transaction = createTransaction(input);
  await assertEntriesMatchTheirAccounts(tx, transaction);

  await tx.insert(transactionsTable).values({
    id: transaction.id,
    householdId: actor.householdId,
    bookedOn: transaction.bookedOn,
    valueOn: transaction.valueOn,
    kind: transaction.kind,
    description: transaction.description ?? null,
    counterparty: transaction.counterparty ?? null,
    source: transaction.source,
    externalId: transaction.externalId ?? null,
    reversesId: transaction.reversesId ?? null,
    importId: transaction.importId ?? null,
    createdBy: actor.userId,
  });

  if (transaction.dedupeHash !== undefined) {
    await tx.insert(dedupeKeys).values({
      transactionId: transaction.id,
      householdId: actor.householdId,
      hash: transaction.dedupeHash,
    });
  }

  await tx.insert(entriesTable).values(
    transaction.entries.map((entry) => ({
      transactionId: transaction.id,
      householdId: actor.householdId,
      accountId: entry.accountId,
      // Decimal to string at the boundary. The numeric columns take text, and
      // any value that passed through Number on the way here would already be
      // wrong (ADR-0006).
      amount: entry.amount.amount.toFixed(),
      currency: entry.amount.currency,
      instrumentId: entry.instrumentId ?? null,
      quantity: entry.quantity?.toFixed() ?? null,
      unitPrice: entry.unitPrice?.amount.toFixed() ?? null,
      memo: entry.memo ?? null,
    })),
  );

  // The original stops standing, and stops reserving its provider identifier.
  // Written here rather than by whoever posts a reversal, so the two cannot
  // drift: a reversal that did not mark its original would leave the ledger
  // saying a cancelled transaction still counts.
  if (transaction.reversesId !== undefined) {
    await tx
      .update(transactionsTable)
      .set({ reversedAt: new Date() })
      .where(eq(transactionsTable.id, transaction.reversesId));
  }

  return { transaction, id: transaction.id };
}

/**
 * The same, for many transactions at once.
 *
 * An import posts one row per movement, and `postTransaction` costs five round
 * trips each: two checks, then the transaction, its deduplication key and its
 * entries. Measured on a file at the ceiling - fifty thousand rows - that was
 * about six minutes, all of it waiting on the network rather than working.
 *
 * What is dropped is only what does not vary. The permission is about the
 * actor, and the tenant check is about the connection: neither changes between
 * the first transaction and the thousandth, so asking once is asking as often
 * as the answer can change. Everything that is about a transaction is still
 * done for every transaction.
 *
 * What is kept, and why it has to be:
 *
 *   - `createTransaction` runs on each one. It is the balance invariant and it
 *     is pure, so it costs nothing and refuses the whole call on the first
 *     transaction that does not balance (ADR-0002).
 *   - every entry is still checked against the currency its account is held in.
 *     The accounts are fetched once for the whole call instead of once per
 *     transaction, which is the same guarantee from one query.
 *   - every row still carries `household_id` and is written under the caller's
 *     binding, so row-level security applies to a thousand-row insert exactly
 *     as it does to one (ADR-0007).
 *   - the database checks the balance again at COMMIT, per transaction, as it
 *     does for anything that arrives by any other route.
 */
export async function postTransactions(
  tx: Database,
  actor: Actor,
  inputs: readonly TransactionInput[],
): Promise<PostTransactionResult[]> {
  assertCan(actor, 'transaction:create', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  if (inputs.length === 0) return [];

  const built = inputs.map((input) => createTransaction(input));

  // A reversal marks the transaction it cancels, and whether that row is in
  // this same batch decides what order the statements have to run in. No
  // caller posts one in bulk - a rollback reverses one at a time - so this
  // refuses rather than growing a case nothing exercises.
  const reversal = built.find((transaction) => transaction.reversesId !== undefined);
  if (reversal !== undefined) {
    throw new Error(`Post a reversal on its own: ${reversal.id} cancels another transaction.`);
  }

  await assertEntriesMatchTheirAccounts(tx, built);

  for (const chunk of chunked(built, BATCH)) {
    await tx.insert(transactionsTable).values(
      chunk.map((transaction) => ({
        id: transaction.id,
        householdId: actor.householdId,
        bookedOn: transaction.bookedOn,
        valueOn: transaction.valueOn,
        kind: transaction.kind,
        description: transaction.description ?? null,
        counterparty: transaction.counterparty ?? null,
        source: transaction.source,
        externalId: transaction.externalId ?? null,
        reversesId: null,
        importId: transaction.importId ?? null,
        createdBy: actor.userId,
      })),
    );

    const keys = chunk
      .filter((transaction) => transaction.dedupeHash !== undefined)
      .map((transaction) => ({
        transactionId: transaction.id,
        householdId: actor.householdId,
        hash: transaction.dedupeHash!,
      }));
    if (keys.length > 0) await tx.insert(dedupeKeys).values(keys);

    // After the transactions of this chunk, never before: an entry references
    // the transaction it belongs to, and a foreign key does not wait.
    await tx.insert(entriesTable).values(
      chunk.flatMap((transaction) =>
        transaction.entries.map((entry) => ({
          transactionId: transaction.id,
          householdId: actor.householdId,
          accountId: entry.accountId,
          // Decimal to string at the boundary, as everywhere (ADR-0006).
          amount: entry.amount.amount.toFixed(),
          currency: entry.amount.currency,
          instrumentId: entry.instrumentId ?? null,
          quantity: entry.quantity?.toFixed() ?? null,
          unitPrice: entry.unitPrice?.amount.toFixed() ?? null,
          memo: entry.memo ?? null,
        })),
      ),
    );
  }

  return built.map((transaction) => ({ transaction, id: transaction.id }));
}

/**
 * How many transactions go in one statement.
 *
 * The plan says a thousand (§8.7). Five hundred, because the limit that
 * actually bites is PostgreSQL's cap of 65,535 parameters per statement, and a
 * transaction is twelve of them plus nine for each of its entries - so a
 * thousand transactions carrying several lines each would be a statement that
 * fails on a file nobody thought was unusual. Half of that leaves room for a
 * broker's export, where one row is three entries.
 */
const BATCH = 500;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

export class CurrencyDoesNotMatchAccountError extends Error {
  readonly code = 'ENTRY_CURRENCY_MISMATCH';
  readonly accountName: string;
  readonly accountCurrency: string;
  readonly entryCurrency: string;

  constructor(accountName: string, accountCurrency: string, entryCurrency: string) {
    super(
      `${accountName} is held in ${accountCurrency}, and this entry is in ${entryCurrency}. ` +
        'An account holds one currency: post this to an account in the right one, or open one.',
    );
    this.name = 'CurrencyDoesNotMatchAccountError';
    this.accountName = accountName;
    this.accountCurrency = accountCurrency;
    this.entryCurrency = entryCurrency;
  }
}

/**
 * An entry may only move the currency its account is held in.
 *
 * Nothing checked this, and the consequence was not an error but a wrong
 * number. Double entry balances per currency, so euros posted into a dollar
 * account balance perfectly against each other and are accepted; then
 * `accountBalances` sums `amount` without looking at `currency` and labels the
 * total with the account's. A dollar account holding euro entries therefore
 * reported a dollar balance that was really a pile of euros - reported from a
 * real import, where an account showed "400.79 $US" of euros.
 *
 * Refused rather than converted. A rate belongs to a day and has to be recorded
 * with the transaction (phase 3); inventing one here would replace a visible
 * refusal with an invisible approximation.
 *
 * One query for the whole transaction, and it names no household: row-level
 * security means an account id from elsewhere matches nothing and is reported
 * as missing rather than as somebody else's.
 */
async function assertEntriesMatchTheirAccounts(
  tx: Database,
  posted: Transaction | readonly Transaction[],
): Promise<void> {
  const all = Array.isArray(posted) ? posted : [posted as Transaction];
  const lines = all.flatMap((transaction) => transaction.entries);
  const ids = [...new Set(lines.map((entry) => entry.accountId))];
  if (ids.length === 0) return;

  // One query for every account the call touches, however many transactions
  // that is. The guarantee is per entry either way.
  const rows = await tx
    .select({ id: accountsTable.id, name: accountsTable.name, currency: accountsTable.currency })
    .from(accountsTable)
    .where(inArray(accountsTable.id, ids));

  const held = new Map(rows.map((row) => [row.id, row]));
  for (const entry of lines) {
    const account = held.get(entry.accountId);
    // A missing account is not this function's error to raise: the foreign key
    // says it better, and saying it here would guess at why it is missing.
    if (account === undefined) continue;
    if (account.currency !== entry.amount.currency) {
      throw new CurrencyDoesNotMatchAccountError(
        account.name,
        account.currency,
        entry.amount.currency,
      );
    }
  }
}

export interface AccountBalance {
  readonly accountId: AccountId;
  readonly name: string;
  readonly kind: string;
  /** Who holds it, when somebody said. Shown, so the field is worth filling in. */
  readonly institution: string | null;
  readonly currency: string;
  /** Derived from `kind` in the database, so it cannot disagree with it. */
  readonly classification: AccountClass;
  /** Null while the account is open. A closed account keeps its history. */
  readonly closedOn: string | null;
  readonly balance: Money;
}

/**
 * Balances per account, summed in the database.
 *
 * `sum` over `numeric` stays exact, which is why ADR-0006 rejected float at the
 * column as well as in TypeScript. postgres.js returns numeric as a string and
 * `Money.of` takes one, so no value passes through `Number` between the
 * database and the screen.
 *
 * The query names no household. Row-level security does that filtering, which
 * means this cannot select the wrong one - there is no parameter to get wrong.
 *
 * The join is left, and the sum coalesced: an account with no entries appears
 * at zero. One that vanished until its first transaction would look like a bug
 * to whoever had just created it.
 */
export async function accountBalances(
  tx: Database,
  actor: Actor,
): Promise<readonly AccountBalance[]> {
  assertCan(actor, 'account:read', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const rows = await tx.execute<{
    id: string;
    name: string;
    kind: string;
    institution: string | null;
    currency: string;
    classification: AccountClass;
    closed_on: string | null;
    balance: string;
  }>(sql`
    SELECT a.id,
           a.name,
           a.kind,
           a.institution,
           a.currency,
           a.classification,
           a.closed_on,
           COALESCE(sum(e.amount), 0)::text AS balance
      FROM accounts a
      LEFT JOIN entries e ON e.account_id = a.id
     GROUP BY a.id, a.name, a.kind, a.institution, a.currency, a.classification, a.closed_on
     ORDER BY a.name
  `);

  return [...rows].map((row) => ({
    accountId: row.id as AccountId,
    name: row.name,
    kind: row.kind,
    institution: row.institution,
    currency: row.currency,
    classification: row.classification,
    closedOn: row.closed_on,
    balance: Money.of(row.balance, row.currency),
  }));
}

/**
 * Net worth: what is owned, less what is owed.
 *
 * A liability's balance is already negative, so assets and liabilities are
 * added rather than subtracted. There is no separate subtraction to get the
 * wrong way round, and no flag an insert can forget - `classification` is
 * generated from `kind`.
 *
 * Equity accounts are excluded, and that exclusion is the whole point of the
 * class existing. An opening balance is the counterpart that makes the first
 * deposit sum to zero (ADR-0002); counting it would make every household worth
 * exactly nothing, and hiding it by calling it a liability - which is what this
 * code did before - excluded real debt along with it.
 *
 * Single currency for now. Combining several needs a dated rate per account,
 * which is phase 3.
 */
export function netWorth(balances: readonly AccountBalance[], currency: string): Money {
  return balances
    .filter((b) => b.currency === currency && b.classification !== 'equity')
    .reduce((total, b) => total.plus(b.balance), Money.zero(currency));
}

export interface LedgerLine {
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly amount: Money;
  /** What this side of the movement was for, when a rule or a person said. */
  readonly category: string | null;
  readonly categoryId: string | null;
}

export interface LedgerEntry {
  readonly id: TransactionId;
  readonly bookedOn: string;
  readonly kind: string;
  readonly description: string | null;
  /** Who was on the other side: the shop, the employer. Null until something reads it. */
  readonly counterparty: string | null;
  /** Labels that cut across categories, on the transaction rather than its sides. */
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly source: string;
  /** Set when this transaction cancels another one. */
  readonly reversesId: TransactionId | null;
  /** Set when another transaction cancels this one. Never both. */
  readonly reversedById: TransactionId | null;
  readonly lines: readonly LedgerLine[];
}

export interface TransactionPage {
  readonly transactions: readonly LedgerEntry[];
  /** How many match the filter. Exact, so "page 3 of 40,000" is the truth. */
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly pageCount: number;
}

/**
 * Which side of a reversal a transaction is on.
 *
 * `reversal` cancels another; `reversed` was cancelled by one. Opposite ends of
 * the same pair, and both are cheap: reverses_id is indexed, and there are few
 * of either.
 *
 * There is deliberately no "neither" option. It reads well - hide the
 * corrections, show the clean ledger - but reversals are rare, so it matches
 * almost every row while costing a full anti-join: measured at 1,062 ms against
 * 0.6 ms for the reversals themselves. A filter that hides four rows out of a
 * million is not worth a second of everyone's time.
 */
export const TRANSACTION_STATUSES = ['all', 'reversal', 'reversed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * Every counterparty this household has recorded, for the filter to offer.
 *
 * Distinct over the same partial index the filter uses, so it is an index-only
 * scan over the rows that have one rather than a pass over the table. Capped,
 * because a select nobody can read is not a select - and a household with more
 * than five hundred distinct shops has outgrown a dropdown anyway.
 */
export async function listCounterparties(tx: Database, actor: Actor): Promise<readonly string[]> {
  assertCan(actor, 'transaction:read', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const rows = await tx.execute<{ counterparty: string }>(sql`
    SELECT DISTINCT t.counterparty
      FROM transactions t
     WHERE t.counterparty IS NOT NULL
     ORDER BY t.counterparty
     LIMIT 500
  `);

  return [...rows].map((row) => row.counterparty);
}

export interface ListOptions {
  /** 1-based. Clamped into range rather than refused. */
  readonly page?: number;
  readonly perPage?: number;
  readonly accountId?: AccountId;
  /** Inclusive, on the booked date. */
  readonly from?: LedgerDate;
  readonly to?: LedgerDate;
  readonly kind?: string;
  readonly status?: TransactionStatus;
  /**
   * The three filters that make a label worth having.
   *
   * A category nobody can filter by is a label, not a feature: "what did I
   * spend on groceries" is the question it was created to answer, and the
   * answer lives here.
   *
   * Each is written the way the existing filter of its shape is. `categoryId`
   * and `tagId` are EXISTS over a child table, like `accountId`, and each has
   * an index of the same shape as the one that filter uses. `counterparty` is
   * a column of `transactions`, like `kind`, and has an index in the same form:
   * household, the column, then the ordering pair, so matching rows come back
   * sorted without a sort step.
   */
  readonly categoryId?: string;
  readonly counterparty?: string;
  readonly tagId?: string;
}

const MAX_PER_PAGE = 200;
const DEFAULT_PER_PAGE = 25;

/**
 * One numbered page of the ledger, newest first, with every line of each
 * transaction.
 *
 * Numbered pages need a count and an offset, which a keyset cursor cannot give:
 * a cursor knows how to continue but never how many there are, so it cannot say
 * "3 of 40". Paging by cursor was tried first and the screen it produced was
 * worse - asking for older entries replaced the recent ones, with nothing to
 * click to get them back.
 *
 * The trade is real and worth naming: a ledger is append-only but not
 * append-ordered, since a transaction booked last week can be inserted today.
 * Insert one while someone is reading page 3 and the boundary between pages
 * shifts under them. That is what page numbers cost everywhere, it is what
 * readers already expect of them, and it is recoverable - the row moved to the
 * next page, it did not vanish.
 *
 * The page number is clamped to what the count found, which is what keeps a
 * crafted `?page=99999999` from asking the database to skip two billion rows.
 *
 * A deep page is still a deep OFFSET: page 16,000 measured at 292 ms on the same
 * million rows, because reaching row 400,000 means walking to it. That cost is
 * paid by whoever jumps there, it is rare - people filter rather than page - and
 * the alternative was making those pages not exist.
 *
 * The queries name no household. Row-level security does that filtering, so a
 * page number cannot be used to read someone else's ledger.
 */
export async function listTransactions(
  tx: Database,
  actor: Actor,
  options: ListOptions = {},
): Promise<TransactionPage> {
  assertCan(actor, 'transaction:read', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const perPage = Math.min(Math.max(options.perPage ?? DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);

  /**
   * Every filter, as one predicate used by both queries.
   *
   * Shared rather than written twice: a count that filtered differently from
   * the page it counts would produce a page number pointing at nothing, and the
   * two drifting apart is the kind of bug that only shows on page 4.
   *
   * `IS NOT DISTINCT FROM` is not needed anywhere here - every column compared
   * is NOT NULL - so plain equality is enough and stays indexable.
   */
  const isReversed = sql`EXISTS (SELECT 1 FROM transactions r WHERE r.reverses_id = t.id)`;

  const clauses = [
    options.accountId === undefined
      ? undefined
      : sql`EXISTS (SELECT 1 FROM entries e
                     WHERE e.transaction_id = t.id
                       AND e.account_id = ${options.accountId}::uuid)`,
    options.from === undefined ? undefined : sql`t.booked_on >= ${options.from}::date`,
    options.to === undefined ? undefined : sql`t.booked_on <= ${options.to}::date`,
    options.kind === undefined || options.kind === '' ? undefined : sql`t.kind = ${options.kind}`,
    options.categoryId === undefined
      ? undefined
      : sql`EXISTS (SELECT 1 FROM entries e
                     WHERE e.transaction_id = t.id
                       AND e.category_id = ${options.categoryId}::uuid)`,
    options.counterparty === undefined || options.counterparty === ''
      ? undefined
      : sql`t.counterparty = ${options.counterparty}`,
    options.tagId === undefined
      ? undefined
      : sql`EXISTS (SELECT 1 FROM transactions_tags tt
                     WHERE tt.transaction_id = t.id
                       AND tt.tag_id = ${options.tagId}::uuid)`,
    options.status === undefined || options.status === 'all'
      ? undefined
      : options.status === 'reversal'
        ? sql`t.reverses_id IS NOT NULL`
        : isReversed,
  ].filter((clause) => clause !== undefined);

  const matches = clauses.length === 0 ? sql`true` : sql.join(clauses, sql` AND `);

  /**
   * A separate query, and deliberately not `count(*) OVER ()`.
   *
   * Measured on a million transactions in one household: the window function
   * took 790 ms, this takes 28. The difference is that the window form pushes
   * every matching row through the executor carrying all its columns, which
   * rules out both parallelism and an index-only scan; this one is a parallel
   * index-only scan over the same index the ordering uses.
   *
   * Counting was capped at ten thousand for a while, which made everything past
   * page 400 unreachable. Thirty milliseconds buys the whole ledger back.
   */
  const [counted] = await tx.execute<{ total: string }>(sql`
    SELECT count(*)::text AS total FROM transactions t WHERE ${matches}
  `);

  const total = Number.parseInt(counted?.total ?? '0', 10);
  const pageCount = Math.max(Math.ceil(total / perPage), 1);
  const page = Math.min(Math.max(options.page ?? 1, 1), pageCount);
  const offset = (page - 1) * perPage;

  /**
   * The page's ids first, then everything else for those ids only.
   *
   * Written as one flat query, the two scalar subqueries sat in the target list
   * of the scan - and OFFSET is applied by a node above it, so the scan had to
   * produce every row up to the offset and evaluate both subqueries for each
   * one. At page 1 that is 25 evaluations and invisible; on the last page of a
   * million it was 1,021,034, and the page took fourteen seconds.
   *
   *   flat query, last page       13,767 ms
   *   ids first, then the rest       192 ms
   *
   * MATERIALIZED is load-bearing: without it PostgreSQL may inline the CTE and
   * fold the whole thing back into the shape this exists to avoid.
   */
  const rows = await tx.execute<{
    id: string;
    booked_on: string;
    kind: string;
    description: string | null;
    source: string;
    counterparty: string | null;
    reverses_id: string | null;
    reversed_by_id: string | null;
    tags: { id: string; name: string }[];
    lines: {
      account_id: string;
      account_name: string;
      amount: string;
      currency: string;
      category: string | null;
      category_id: string | null;
    }[];
  }>(sql`
    WITH page AS MATERIALIZED (
      SELECT t.id
        FROM transactions t
       WHERE ${matches}
       -- NULLS LAST is not decoration. Drizzle writes the index as
       -- "booked_on DESC NULLS LAST", a bare ORDER BY ... DESC means NULLS
       -- FIRST, and PostgreSQL will not use an index whose order differs from
       -- the one asked for - even when the column is NOT NULL and the two can
       -- never differ. 176 ms sorting the table, against 1.4 ms once the two
       -- spellings agree.
       ORDER BY t.booked_on DESC NULLS LAST, t.id DESC NULLS LAST
       LIMIT ${perPage} OFFSET ${offset}
    )
    SELECT t.id,
           t.booked_on::text AS booked_on,
           t.kind,
           t.description,
           t.source,
           t.counterparty,
           t.reverses_id,
           (SELECT r.id FROM transactions r WHERE r.reverses_id = t.id LIMIT 1) AS reversed_by_id,
           -- Evaluated for the page's rows only, like the entries below: the
           -- CTE above is MATERIALIZED precisely so these run twenty-five times
           -- and not once per row scanned to reach the offset.
           COALESCE(
             (SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
                FROM transactions_tags tt
                JOIN tags g ON g.id = tt.tag_id
               WHERE tt.transaction_id = t.id),
             '[]'::json
           ) AS tags,
           COALESCE(
             (SELECT json_agg(json_build_object(
                       'account_id', e.account_id,
                       'account_name', a.name,
                       'amount', e.amount::text,
                       'currency', e.currency,
                       'category', c.name,
                       'category_id', e.category_id
                     ) ORDER BY e.amount DESC, a.name)
                FROM entries e
                JOIN accounts a ON a.id = e.account_id
                LEFT JOIN categories c ON c.id = e.category_id
               WHERE e.transaction_id = t.id),
             '[]'::json
           ) AS lines
      FROM page p
      JOIN transactions t ON t.id = p.id
     ORDER BY t.booked_on DESC NULLS LAST, t.id DESC NULLS LAST
  `);

  return {
    transactions: [...rows].map((row) => ({
      id: row.id as TransactionId,
      bookedOn: row.booked_on,
      kind: row.kind,
      description: row.description,
      source: row.source,
      counterparty: row.counterparty,
      tags: row.tags,
      reversesId: row.reverses_id as TransactionId | null,
      reversedById: row.reversed_by_id as TransactionId | null,
      lines: row.lines.map((line) => ({
        accountId: line.account_id as AccountId,
        accountName: line.account_name,
        amount: Money.of(line.amount, line.currency),
        category: line.category,
        categoryId: line.category_id,
      })),
    })),
    total,
    page,
    perPage,
    pageCount,
  };
}

export class AlreadyReversedError extends Error {
  readonly code = 'TRANSACTION_ALREADY_REVERSED';
  constructor(id: TransactionId) {
    super(`Transaction ${id} has already been reversed.`);
    this.name = 'AlreadyReversedError';
  }
}

export class TransactionNotFoundError extends Error {
  readonly code = 'TRANSACTION_NOT_FOUND';
  constructor(id: TransactionId) {
    // The same message whether it belongs to another household or does not
    // exist. Telling those apart answers "does this id exist somewhere?".
    super(`No transaction ${id} in this household.`);
    this.name = 'TransactionNotFoundError';
  }
}

/**
 * Cancels a transaction by posting its mirror image.
 *
 * Nothing is edited and nothing is deleted: the ledger is append-only, so what
 * happened stays readable and what it was corrected by sits next to it
 * (ADR-0002). Both rows remain, and the two sum to nothing.
 *
 * Reversing a reversal is allowed - undoing an undo is a real correction - but
 * reversing the same transaction twice is not, or the ledger would lose the
 * amount a second time. The check and the insert share one transaction, so two
 * clicks racing each other cannot both pass it.
 */
export async function reverseTransactionById(
  tx: Database,
  actor: Actor,
  original: TransactionId,
  reversalId: TransactionId,
  bookedOn: LedgerDate,
): Promise<PostTransactionResult> {
  assertCan(actor, 'transaction:delete', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const [row] = await tx.execute<{
    kind: string;
    source: string;
    reversed_by_id: string | null;
  }>(sql`
    SELECT t.kind,
           t.source,
           (SELECT r.id FROM transactions r WHERE r.reverses_id = t.id LIMIT 1) AS reversed_by_id
      FROM transactions t
     WHERE t.id = ${original}::uuid
  `);

  if (row === undefined) throw new TransactionNotFoundError(original);
  if (row.reversed_by_id !== null) throw new AlreadyReversedError(original);

  // Every column an entry can carry, not the four a cash transfer needs. Read
  // without `instrument_id`, a purchase came back as a quantity of nothing, and
  // the domain refused to rebuild it: "a quantity was given without an
  // instrument". Reversing a transfer worked, so the gap only appeared the day
  // something reversed a trade - which is what undoing a broker import does.
  const lines = await tx.execute<{
    account_id: string;
    amount: string;
    currency: string;
    quantity: string | null;
    unit_price: string | null;
    instrument_id: string | null;
    memo: string | null;
  }>(sql`
    SELECT account_id, amount::text, currency, quantity::text,
           unit_price::text, instrument_id, memo
      FROM entries
     WHERE transaction_id = ${original}::uuid
  `);

  // Rebuilt as a domain transaction and negated by `reverseTransaction`, the
  // same pure function the unit tests exercise - rather than by writing the
  // opposite signs here, where a sign is one keystroke from being wrong.
  const rebuilt = createTransaction({
    id: original,
    bookedOn,
    kind: row.kind as Transaction['kind'],
    source: row.source as Transaction['source'],
    entries: [...lines].map((line) => ({
      accountId: line.account_id as AccountId,
      amount: Money.of(line.amount, line.currency),
      ...(line.quantity === null ? {} : { quantity: dec(line.quantity) }),
      ...(line.unit_price === null ? {} : { unitPrice: Money.of(line.unit_price, line.currency) }),
      ...(line.instrument_id === null ? {} : { instrumentId: instrumentId(line.instrument_id) }),
      ...(line.memo === null ? {} : { memo: line.memo }),
    })),
  });

  const reversal = reverseTransaction(rebuilt, reversalId, bookedOn);

  // Widened back to an input. `Transaction` carries its optional fields as
  // `string | undefined`, which under exactOptionalPropertyTypes is not the same
  // thing as absent - so the ones that are unset are dropped rather than passed
  // along as an explicit undefined.
  return postTransaction(tx, actor, {
    id: reversal.id,
    bookedOn: reversal.bookedOn,
    kind: reversal.kind,
    source: reversal.source,
    reversesId: original,
    entries: reversal.entries,
    ...(reversal.description === undefined ? {} : { description: reversal.description }),
  });
}
