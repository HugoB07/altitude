import { Decimal, compareDates, type CurrencyCode } from '@altitude/shared';
import {
  InconsistentHoldingError,
  InsufficientEntriesError,
  InvalidDateRangeError,
  UnbalancedTransactionError,
} from './errors';
import type { Entry, Transaction, TransactionInput } from './types';

/**
 * Sums the entries of a transaction, grouped by currency.
 *
 * Exported because reporting and reconciliation need the same grouping, and two
 * implementations of "what does this transaction total" would eventually disagree.
 */
export function sumByCurrency(
  entries: readonly { amount: { amount: Decimal; currency: CurrencyCode } }[],
): Map<CurrencyCode, Decimal> {
  const totals = new Map<CurrencyCode, Decimal>();
  for (const entry of entries) {
    const current = totals.get(entry.amount.currency) ?? new Decimal(0);
    totals.set(entry.amount.currency, current.plus(entry.amount.amount));
  }
  return totals;
}

/**
 * Validates a transaction and returns it in a form the rest of the system can trust.
 *
 * This is the only door into the ledger. Everything upstream - manual entry, CSV
 * import, a bank connector - funnels through here, so the invariant is enforced
 * once rather than at each call site (ADR-0002).
 *
 * Checks, in order:
 *
 * 1. At least two entries.
 * 2. Every currency sums to exactly zero. Exactly, not within an epsilon: the
 *    amounts are decimals, so there is no rounding noise to tolerate (ADR-0006).
 * 3. Quantity and instrument are either both present or both absent.
 * 4. The value date is not before the booking date.
 *
 * Balance is checked **per currency**, never on a converted total. A transaction
 * with +100 EUR and −100 USD is not balanced; it is two unbalanced halves that
 * happen to look similar. Real currency exchanges post through an FX account so
 * that each side balances on its own.
 *
 * @throws {InsufficientEntriesError} fewer than two entries
 * @throws {UnbalancedTransactionError} some currency does not sum to zero
 * @throws {InconsistentHoldingError} quantity without instrument, or the reverse
 * @throws {InvalidDateRangeError} value date before booking date
 */
export function createTransaction(input: TransactionInput): Transaction {
  const { id, entries } = input;

  if (entries.length < 2) {
    throw new InsufficientEntriesError(id, entries.length);
  }

  for (const entry of entries) {
    const hasQuantity = entry.quantity !== undefined;
    const hasInstrument = entry.instrumentId !== undefined;
    if (hasQuantity !== hasInstrument) {
      throw new InconsistentHoldingError(
        id,
        hasQuantity
          ? 'a quantity was given without an instrument'
          : 'an instrument was given without a quantity',
      );
    }
    if (entry.unitPrice !== undefined && !hasQuantity) {
      throw new InconsistentHoldingError(id, 'a unit price was given without a quantity');
    }
  }

  const totals = sumByCurrency(entries);
  const residuals = new Map<CurrencyCode, string>();
  for (const [code, total] of totals) {
    if (!total.isZero()) {
      residuals.set(code, total.toFixed());
    }
  }
  if (residuals.size > 0) {
    throw new UnbalancedTransactionError(id, residuals);
  }

  const valueOn = input.valueOn ?? input.bookedOn;
  if (compareDates(valueOn, input.bookedOn) < 0) {
    throw new InvalidDateRangeError(id, input.bookedOn, valueOn);
  }

  const boundEntries: readonly Entry[] = entries.map((entry) => ({ ...entry, transactionId: id }));

  return {
    id,
    bookedOn: input.bookedOn,
    valueOn,
    kind: input.kind,
    description: input.description,
    counterparty: input.counterparty,
    source: input.source ?? 'manual',
    externalId: input.externalId,
    dedupeHash: input.dedupeHash,
    reversesId: input.reversesId,
    importId: input.importId,
    entries: boundEntries,
    currencies: [...totals.keys()].sort(),
  };
}

/**
 * Builds the transaction that cancels another one.
 *
 * The ledger is append-only: a mistake is corrected by posting its mirror image,
 * never by editing history (ADR-0002). Negating every line of a balanced
 * transaction yields a balanced transaction, so the result is valid by
 * construction - but it goes through `createTransaction` anyway, because an
 * invariant enforced in one place only is an invariant enforced everywhere.
 */
export function reverseTransaction(
  original: Transaction,
  id: Transaction['id'],
  bookedOn: Transaction['bookedOn'],
): Transaction {
  return createTransaction({
    id,
    bookedOn,
    kind: original.kind,
    description: `Reversal of ${original.id}`,
    source: original.source,
    reversesId: original.id,
    entries: original.entries.map((entry) => ({
      ...entry,
      amount: entry.amount.negated(),
      ...(entry.quantity !== undefined ? { quantity: entry.quantity.negated() } : {}),
    })),
  });
}
