import { getTranslations } from 'next-intl/server';
import {
  AccountError,
  AlreadyReversedError,
  CurrencyDoesNotMatchAccountError,
  ForbiddenError,
  LedgerError,
  TenantScopeError,
  TransactionNotFoundError,
} from '@altitude/core';

/**
 * One of the two accounts a transfer names is not in this household.
 *
 * Its own class rather than a bare `Error`, because a bare `Error` is exactly
 * what `toMessage` refuses to show - and it is right to: the point of that list
 * is that anything not on it was written for a stack trace.
 */
export class AccountsMissingError extends Error {
  readonly code = 'ACCOUNTS_MISSING';
  constructor() {
    super('One of those accounts is not in this household.');
    this.name = 'AccountsMissingError';
  }
}

/**
 * Errors whose text was written for a person to read.
 *
 * Everything the domain refuses explains itself, and that explanation is worth
 * showing. Everything else is a driver or a bug, and its text is written for
 * whoever is holding a stack trace - postgres.js says "Failed query: insert
 * into transactions (...) values ($1, $2, ...)" and then prints the parameters,
 * which on this screen means printing somebody's transaction back at them as a
 * SQL statement. That reached a person.
 *
 * A list rather than a guess. `instanceof Error` was the guess; sniffing for a
 * `code` property would be the next one, and postgres.js sets `code` too.
 */
const EXPLAINS_ITSELF = [
  LedgerError,
  AccountError,
  ForbiddenError,
  TenantScopeError,
  CurrencyDoesNotMatchAccountError,
  AlreadyReversedError,
  TransactionNotFoundError,
  AccountsMissingError,
] as const;

export async function toMessage(error: unknown): Promise<string> {
  if (EXPLAINS_ITSELF.some((kind) => error instanceof kind)) return (error as Error).message;

  // Kept where an operator can find it, since the screen is about to say
  // nothing useful about it.
  console.error('[altitude] unexpected error in a server action', error);
  const t = await getTranslations('quickAdd');
  return t('genericError');
}
