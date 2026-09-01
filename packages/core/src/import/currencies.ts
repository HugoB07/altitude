import { isCurrencyCode } from '@altitude/shared';

/**
 * Reading the currency cell of a statement.
 *
 * `currency` in `@altitude/shared` throws on what it cannot accept, which is
 * right at the ledger's door and wrong here: while reading a file, a bad value
 * has to become a problem carrying its line number, not an exception that
 * loses the row it came from (plan §8.2, step 5).
 */

/**
 * Symbols a statement writes instead of a code, where the symbol names one
 * currency and only one.
 *
 * `$` is deliberately absent. It is the dollar of at least four countries, and
 * guessing between them is the same silent wrong answer as reading 03/04 as
 * the third of April: the reader says it cannot tell, and the mapping has a
 * field for saying which currency the file is in.
 */
const SYMBOLS: Readonly<Record<string, string>> = {
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
};

/** The code this cell means, or null when it means nothing the ledger takes. */
export function readCurrency(cell: string): string | null {
  const text = cell.trim();
  if (text === '') return null;

  const named = SYMBOLS[text];
  if (named !== undefined) return named;

  const upper = text.toUpperCase();
  return isCurrencyCode(upper) ? upper : null;
}
