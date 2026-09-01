import type {
  AccountId,
  ImportId,
  CategoryId,
  CurrencyCode,
  Decimal,
  InstrumentId,
  LedgerDate,
  Money,
  TransactionId,
} from '@altitude/shared';

/**
 * What kind of economic event a transaction records.
 *
 * This is descriptive, not structural: the balance invariant applies to every
 * kind alike. It exists so the UI can pick a form and reports can group, not so
 * the engine can branch on it.
 */
export const TRANSACTION_KINDS = [
  'buy',
  'sell',
  'dividend',
  'interest',
  'fee',
  'tax',
  'deposit',
  'withdrawal',
  'transfer',
  'fx',
  'revaluation',
  'split',
  'adjustment',
] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Where a transaction came from. Drives what an undo is allowed to remove. */
export type TransactionSource = 'manual' | 'import' | 'connector' | 'rule';

/**
 * One side of a transaction.
 *
 * `amount` is signed from the account's point of view: positive means value
 * entering the account, negative means leaving it.
 *
 * `quantity` and `instrument` are set only when the line moves a holding rather
 * than cash. A share purchase produces two lines: one negative cash line, and one
 * line carrying a positive quantity of the instrument.
 */
export interface EntryInput {
  readonly accountId: AccountId;
  readonly amount: Money;
  readonly instrumentId?: InstrumentId;
  readonly quantity?: Decimal;
  readonly unitPrice?: Money;
  /** Rate to the household's base currency, frozen at booking time (plan §5.3). */
  readonly fxRateToBase?: Decimal;
  readonly categoryId?: CategoryId;
  readonly memo?: string;
}

export interface Entry extends EntryInput {
  readonly transactionId: TransactionId;
}

export interface TransactionInput {
  readonly id: TransactionId;
  readonly bookedOn: LedgerDate;
  readonly valueOn?: LedgerDate;
  readonly kind: TransactionKind;
  readonly description?: string;
  readonly counterparty?: string;
  readonly source?: TransactionSource;
  /** Provider identifier, used for import and sync idempotency. */
  readonly externalId?: string;
  /**
   * sha256 over the date, the entries and the normalised label (plan §8.5).
   *
   * What makes importing the same file twice painless where the bank gives no
   * identifier of its own, which is most French statements. Set by the import;
   * never by hand, where there is no file to have written it.
   */
  readonly dedupeHash?: string;
  /** Set when this transaction reverses another; the ledger is append-only. */
  readonly reversesId?: TransactionId;
  /**
   * The import run that produced this, when one did.
   *
   * Provenance, alongside `source` and `externalId`, rather than a service
   * concern bolted on: undoing an import has to be able to find its rows, and a
   * transaction that cannot say where it came from cannot be found by anything
   * but a date.
   */
  readonly importId?: ImportId;
  readonly entries: readonly EntryInput[];
}

/**
 * A transaction that has passed validation.
 *
 * The only way to obtain one is through `createTransaction`, so holding a value
 * of this type is proof the invariant held. Nothing downstream needs to re-check.
 */
export interface Transaction {
  readonly id: TransactionId;
  readonly bookedOn: LedgerDate;
  readonly valueOn: LedgerDate;
  readonly kind: TransactionKind;
  readonly description: string | undefined;
  readonly counterparty: string | undefined;
  readonly source: TransactionSource;
  readonly externalId: string | undefined;
  readonly dedupeHash: string | undefined;
  readonly reversesId: TransactionId | undefined;
  readonly importId: ImportId | undefined;
  readonly entries: readonly Entry[];
  /** Currencies this transaction touches, each of which balances to zero. */
  readonly currencies: readonly CurrencyCode[];
}
