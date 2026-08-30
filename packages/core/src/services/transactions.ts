import { sql } from 'drizzle-orm';
import { entries as entriesTable, transactions as transactionsTable } from '@altitude/db';
import type { AccountClass, Database } from '@altitude/db';
import { Money, type AccountId, type TransactionId } from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
import { assertActorMatchesTenant, TenantScopeError } from './tenant';

// Re-exported so the move out of this file is invisible to importers.
export { TenantScopeError };
import { createTransaction } from '../ledger/create-transaction';
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

export interface AccountBalance {
  readonly accountId: AccountId;
  readonly name: string;
  readonly kind: string;
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
    currency: string;
    classification: AccountClass;
    closed_on: string | null;
    balance: string;
  }>(sql`
    SELECT a.id,
           a.name,
           a.kind,
           a.currency,
           a.classification,
           a.closed_on,
           COALESCE(sum(e.amount), 0)::text AS balance
      FROM accounts a
      LEFT JOIN entries e ON e.account_id = a.id
     GROUP BY a.id, a.name, a.kind, a.currency, a.classification, a.closed_on
     ORDER BY a.name
  `);

  return [...rows].map((row) => ({
    accountId: row.id as AccountId,
    name: row.name,
    kind: row.kind,
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
