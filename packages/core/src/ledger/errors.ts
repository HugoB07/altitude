import type { CurrencyCode, TransactionId } from '@altitude/shared';

export abstract class LedgerError extends Error {
  abstract readonly code: string;
}

/** One currency's lines did not sum to zero - the invariant of ADR-0002. */
export class UnbalancedTransactionError extends LedgerError {
  readonly code = 'LEDGER_UNBALANCED';
  readonly transactionId: TransactionId;
  /** Residual per offending currency, as exact decimal strings. */
  readonly residuals: ReadonlyMap<CurrencyCode, string>;

  constructor(transactionId: TransactionId, residuals: ReadonlyMap<CurrencyCode, string>) {
    const detail = [...residuals]
      .map(([code, residual]) => `${code} off by ${residual}`)
      .join(', ');
    super(`Transaction ${transactionId} does not balance: ${detail}.`);
    this.name = 'UnbalancedTransactionError';
    this.transactionId = transactionId;
    this.residuals = residuals;
  }
}

/** Fewer than two lines. A single-sided entry is not a double-entry transaction. */
export class InsufficientEntriesError extends LedgerError {
  readonly code = 'LEDGER_INSUFFICIENT_ENTRIES';

  constructor(transactionId: TransactionId, count: number) {
    super(
      `Transaction ${transactionId} has ${count} ${count === 1 ? 'entry' : 'entries'}: ` +
        'at least two are required.',
    );
    this.name = 'InsufficientEntriesError';
  }
}

/** A line carries a quantity without an instrument, or the reverse. */
export class InconsistentHoldingError extends LedgerError {
  readonly code = 'LEDGER_INCONSISTENT_HOLDING';

  constructor(transactionId: TransactionId, reason: string) {
    super(`Transaction ${transactionId} has an inconsistent holding line: ${reason}.`);
    this.name = 'InconsistentHoldingError';
  }
}

/** The value date precedes the booking date, which no real instrument does. */
export class InvalidDateRangeError extends LedgerError {
  readonly code = 'LEDGER_INVALID_DATE_RANGE';

  constructor(transactionId: TransactionId, bookedOn: string, valueOn: string) {
    super(
      `Transaction ${transactionId} has a value date (${valueOn}) before its ` +
        `booking date (${bookedOn}).`,
    );
    this.name = 'InvalidDateRangeError';
  }
}
