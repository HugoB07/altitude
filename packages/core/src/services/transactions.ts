import { sql } from 'drizzle-orm';
import { entries as entriesTable, transactions as transactionsTable } from '@altitude/db';
import type { Database } from '@altitude/db';
import { Money, type AccountId, type TransactionId } from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
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

/**
 * Verifies the actor belongs to the household this transaction is bound to.
 *
 * `assertCan` compares the actor's household to the resource's, which for a
 * whole-household query means comparing it to itself — it checks the role and
 * nothing about tenancy. The tenancy that matters here is the connection's:
 * `withHousehold` set it, and an actor from a different household reaching this
 * point means a caller scoped to one and authorised against another.
 *
 * Row-level security would still return the right rows, so nothing would look
 * wrong — the caller would simply be acting for a household it did not intend.
 * That is a bug worth failing on rather than serving.
 */
async function assertActorMatchesTenant(tx: Database, actor: Actor): Promise<void> {
  const [row] = await tx.execute<{ tenant: string | null }>(
    sql`SELECT current_setting('app.current_household', true) AS tenant`,
  );
  const tenant = row?.tenant ?? '';

  if (tenant === '') {
    throw new TenantScopeError(
      'This work is not bound to a household. Wrap it in withHousehold().',
    );
  }
  if (tenant !== actor.householdId) {
    throw new TenantScopeError(
      `Actor belongs to household ${actor.householdId} but this work is bound to ${tenant}.`,
    );
  }
}

export class TenantScopeError extends Error {
  readonly code = 'TENANT_SCOPE_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

export interface PostTransactionResult {
  readonly transaction: Transaction;
  readonly id: TransactionId;
}

/**
 * Validates a transaction, checks the actor may post it, and writes it.
 *
 * Authorise, then validate, then persist — in that order, everywhere.
 *
 * Authorisation first because a refusal must not depend on whether the input
 * was well formed: otherwise the error tells someone who may not act here what
 * the system thinks of their data.
 *
 * Validation is `createTransaction` from the domain — the same function the
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
  readonly isLiability: boolean;
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
 * means this cannot select the wrong one — there is no parameter to get wrong.
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
    is_liability: boolean;
    balance: string;
  }>(sql`
    SELECT a.id,
           a.name,
           a.kind,
           a.currency,
           a.is_liability,
           COALESCE(sum(e.amount), 0)::text AS balance
      FROM accounts a
      LEFT JOIN entries e ON e.account_id = a.id
     GROUP BY a.id, a.name, a.kind, a.currency, a.is_liability
     ORDER BY a.name
  `);

  return [...rows].map((row) => ({
    accountId: row.id as AccountId,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
    isLiability: row.is_liability,
    balance: Money.of(row.balance, row.currency),
  }));
}

/**
 * Net worth: the sum of every balance.
 *
 * Liabilities are accounts whose balances are negative, so the sum is the whole
 * calculation. There is no separate subtraction to get wrong, and no flag an
 * insert can forget — `is_liability` is a generated column.
 *
 * Single currency for now. Combining several needs a dated rate per account,
 * which is phase 3.
 */
export function netWorth(balances: readonly AccountBalance[], currency: string): Money {
  return balances
    .filter((b) => b.currency === currency)
    .reduce((total, b) => total.plus(b.balance), Money.zero(currency));
}
