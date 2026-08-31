import { inArray, sql } from 'drizzle-orm';
import {
  accounts as accountsTable,
  entries as entriesTable,
  transactions as transactionsTable,
} from '@altitude/db';
import type { AccountClass, Database } from '@altitude/db';
import { Money, dec, type AccountId, type LedgerDate, type TransactionId } from '@altitude/shared';
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

  return { transaction, id: transaction.id };
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
  transaction: Transaction,
): Promise<void> {
  const ids = [...new Set(transaction.entries.map((entry) => entry.accountId))];
  if (ids.length === 0) return;

  const rows = await tx
    .select({ id: accountsTable.id, name: accountsTable.name, currency: accountsTable.currency })
    .from(accountsTable)
    .where(inArray(accountsTable.id, ids));

  const held = new Map(rows.map((row) => [row.id, row]));
  for (const entry of transaction.entries) {
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
}

export interface LedgerEntry {
  readonly id: TransactionId;
  readonly bookedOn: string;
  readonly kind: string;
  readonly description: string | null;
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
    reverses_id: string | null;
    reversed_by_id: string | null;
    lines: { account_id: string; account_name: string; amount: string; currency: string }[];
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
           t.reverses_id,
           (SELECT r.id FROM transactions r WHERE r.reverses_id = t.id LIMIT 1) AS reversed_by_id,
           COALESCE(
             (SELECT json_agg(json_build_object(
                       'account_id', e.account_id,
                       'account_name', a.name,
                       'amount', e.amount::text,
                       'currency', e.currency
                     ) ORDER BY e.amount DESC, a.name)
                FROM entries e
                JOIN accounts a ON a.id = e.account_id
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
      reversesId: row.reverses_id as TransactionId | null,
      reversedById: row.reversed_by_id as TransactionId | null,
      lines: row.lines.map((line) => ({
        accountId: line.account_id as AccountId,
        accountName: line.account_name,
        amount: Money.of(line.amount, line.currency),
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

  const lines = await tx.execute<{
    account_id: string;
    amount: string;
    currency: string;
    quantity: string | null;
  }>(sql`
    SELECT account_id, amount::text, currency, quantity::text
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
