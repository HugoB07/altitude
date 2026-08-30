import { eq, sql } from 'drizzle-orm';
import { ACCOUNT_KINDS, EQUITY_KINDS, accounts, portfolios } from '@altitude/db';
import type { AccountKind, Database } from '@altitude/db';
import { dec, currency, type AccountId, type LedgerDate } from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
import { assertActorMatchesTenant } from './tenant';

/**
 * Creating, renaming and closing accounts.
 *
 * Like every service, these take a transaction handle rather than opening one,
 * so the tenant binding stays at the edge where the session is (ADR-0007), and
 * they authorise themselves rather than trusting the caller to have done it
 * (ADR-0005).
 *
 * No query here names a household. Row-level security does that filtering,
 * which is what makes `WHERE id = $1` safe: an id belonging to someone else
 * matches no row rather than the wrong one.
 */

export abstract class AccountError extends Error {
  abstract readonly code: string;
}

export class InvalidAccountError extends AccountError {
  readonly code = 'ACCOUNT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAccountError';
  }
}

export class AccountNotFoundError extends AccountError {
  readonly code = 'ACCOUNT_NOT_FOUND';
  constructor(accountId: AccountId) {
    // Deliberately the same message whether the account belongs to another
    // household or does not exist. Distinguishing them would answer "does this
    // id exist somewhere?" for anyone who asked.
    super(`No account ${accountId} in this household.`);
    this.name = 'AccountNotFoundError';
  }
}

export class AccountNotEmptyError extends AccountError {
  readonly code = 'ACCOUNT_NOT_EMPTY';
  readonly balance: string;
  constructor(accountId: AccountId, balance: string) {
    super(
      `Account ${accountId} still holds ${balance} and cannot be closed. ` +
        'Move the balance out first, or reverse the transactions that put it there.',
    );
    this.name = 'AccountNotEmptyError';
    this.balance = balance;
  }
}

/** Longer than any real account name, short enough to keep a row on one line. */
const MAX_NAME = 120;

/**
 * The kinds a person may pick.
 *
 * Equity is excluded on purpose. The opening balance account is plumbing that
 * `createHousehold` puts there once (ADR-0002); a second one would balance
 * nothing extra and would give the account list two entries nobody asked for.
 */
export const CREATABLE_KINDS = ACCOUNT_KINDS.filter(
  (kind): kind is Exclude<AccountKind, (typeof EQUITY_KINDS)[number]> =>
    !EQUITY_KINDS.includes(kind as (typeof EQUITY_KINDS)[number]),
);

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '') throw new InvalidAccountError('An account needs a name.');
  if (name.length > MAX_NAME) {
    throw new InvalidAccountError(`An account name is at most ${MAX_NAME} characters.`);
  }
  return name;
}

export interface NewAccount {
  readonly name: string;
  readonly kind: string;
  readonly currency: string;
  readonly institution?: string;
  readonly openedOn?: LedgerDate;
}

export async function createAccount(
  tx: Database,
  actor: Actor,
  input: NewAccount,
): Promise<{ id: AccountId }> {
  assertCan(actor, 'account:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const name = cleanName(input.name);

  if (!CREATABLE_KINDS.includes(input.kind as (typeof CREATABLE_KINDS)[number])) {
    throw new InvalidAccountError(`"${input.kind}" is not an account kind that can be created.`);
  }

  // Throws on anything that is not a currency code, rather than storing it and
  // discovering later that no rate exists for "EURO".
  const code = currency(input.currency);

  // The household's root portfolio. Portfolios are phase 4; until then every
  // account hangs off the one createHousehold made, and the query finds it by
  // shape rather than by an id the caller could get wrong.
  const [root] = await tx
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(eq(portfolios.path, 'home'))
    .limit(1);

  if (root === undefined) {
    throw new InvalidAccountError('This household has no root portfolio.');
  }

  const [created] = await tx
    .insert(accounts)
    .values({
      householdId: actor.householdId,
      portfolioId: root.id,
      name,
      kind: input.kind,
      currency: code,
      ...(input.institution !== undefined && input.institution.trim() !== ''
        ? { institution: input.institution.trim() }
        : {}),
      ...(input.openedOn !== undefined ? { openedOn: input.openedOn } : {}),
    })
    .returning({ id: accounts.id });

  return { id: created!.id as AccountId };
}

export async function renameAccount(
  tx: Database,
  actor: Actor,
  accountId: AccountId,
  rawName: string,
): Promise<void> {
  assertCan(actor, 'account:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const name = cleanName(rawName);

  const changed = await tx
    .update(accounts)
    .set({ name })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });

  if (changed.length === 0) throw new AccountNotFoundError(accountId);
}

/**
 * Closes an account, refusing while it still holds anything.
 *
 * A closed account is hidden from the dashboard, so closing one with a balance
 * would remove real money from view while leaving it in the ledger. That is the
 * same shape as the bug that made net worth exclude every liability: a total
 * that is wrong in a direction nobody checks.
 *
 * The balance is read inside the same transaction as the update, so a
 * transaction posted between the two cannot slip past the check.
 */
export async function closeAccount(
  tx: Database,
  actor: Actor,
  accountId: AccountId,
  on: LedgerDate,
): Promise<void> {
  assertCan(actor, 'account:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const [row] = await tx.execute<{ balance: string }>(sql`
    SELECT COALESCE(sum(e.amount), 0)::text AS balance
      FROM accounts a
      LEFT JOIN entries e ON e.account_id = a.id
     WHERE a.id = ${accountId}
     GROUP BY a.id
  `);

  if (row === undefined) throw new AccountNotFoundError(accountId);
  // Compared as a Decimal, never through Number. A balance of 1e-18 parses to a
  // float that is not zero but prints as though it were, and "0.00" and "0" are
  // both zero while being different strings (ADR-0006).
  if (!dec(row.balance).isZero()) {
    throw new AccountNotEmptyError(accountId, row.balance);
  }

  await tx.update(accounts).set({ closedOn: on }).where(eq(accounts.id, accountId));
}

/** Reopens a closed account. A no-op on one that is already open. */
export async function reopenAccount(
  tx: Database,
  actor: Actor,
  accountId: AccountId,
): Promise<void> {
  assertCan(actor, 'account:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const changed = await tx
    .update(accounts)
    .set({ closedOn: null })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });

  if (changed.length === 0) throw new AccountNotFoundError(accountId);
}
