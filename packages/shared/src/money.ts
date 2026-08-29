import { Decimal, dec, type DecimalInput } from './decimal';

/**
 * A currency code: ISO 4217 for fiat, and the ticker for crypto and stablecoins,
 * which the plan treats as currencies rather than as securities (§11.3).
 *
 * Kept as a validated string rather than a closed union: an instance may hold
 * currencies the project has never heard of, and a union would have to be edited
 * for every one of them.
 */
export type CurrencyCode = string;

const CURRENCY_RE = /^[A-Z]{3,10}$/;

export function currency(code: string): CurrencyCode {
  const upper = code.toUpperCase();
  if (!CURRENCY_RE.test(upper)) {
    throw new TypeError(`Invalid currency code: ${JSON.stringify(code)}.`);
  }
  return upper;
}

export class CurrencyMismatchError extends Error {
  readonly left: CurrencyCode;
  readonly right: CurrencyCode;

  constructor(left: CurrencyCode, right: CurrencyCode) {
    super(
      `Cannot combine ${left} and ${right} directly. ` +
        'Crossing currencies requires an explicit dated rate (ADR-0006).',
    );
    this.name = 'CurrencyMismatchError';
    this.left = left;
    this.right = right;
  }
}

/**
 * An exact monetary amount and its currency.
 *
 * The `C` parameter carries the currency into the type system. Where currencies
 * are known statically — `Money<'EUR'>` and `Money<'USD'>` — mixing them is a
 * compile error. Where they are dynamic, as with a value read from the database,
 * `C` widens to `string` and the check happens at runtime instead.
 *
 * Instances are immutable: every operation returns a new `Money`.
 *
 * No operation rounds. Precision is preserved throughout a computation and
 * rounding happens only at a display or persistence boundary, where the mode is
 * stated explicitly (ADR-0006).
 */
export class Money<C extends CurrencyCode = CurrencyCode> {
  readonly amount: Decimal;
  readonly currency: C;

  private constructor(amount: Decimal, code: C) {
    this.amount = amount;
    this.currency = code;
    Object.freeze(this);
  }

  static of<C extends CurrencyCode>(amount: DecimalInput, code: C): Money<C> {
    return new Money(dec(amount), currency(code) as C);
  }

  static zero<C extends CurrencyCode>(code: C): Money<C> {
    return Money.of('0', code);
  }

  /** Sums a list, verifying every entry shares the same currency. */
  static sum<C extends CurrencyCode>(values: readonly Money<C>[], code: C): Money<C> {
    return values.reduce<Money<C>>((acc, v) => acc.plus(v), Money.zero(code));
  }

  private assertSameCurrency(other: Money<CurrencyCode>): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  plus(other: Money<C>): Money<C> {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money<C>): Money<C> {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Scales by a dimensionless factor — a quantity or a ratio, never a Money. */
  times(factor: DecimalInput): Money<C> {
    return new Money(this.amount.times(dec(factor)), this.currency);
  }

  negated(): Money<C> {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money<C> {
    return new Money(this.amount.abs(), this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero();
  }

  equals(other: Money<C>): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /** −1, 0 or 1. Throws on a currency mismatch: an ordering across currencies is meaningless. */
  compare(other: Money<C>): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }

  /**
   * Rounds to a number of decimal places. The only place rounding is allowed,
   * and the caller has to ask for it.
   */
  round(decimalPlaces: number): Money<C> {
    return new Money(this.amount.toDecimalPlaces(decimalPlaces), this.currency);
  }

  /** Full precision, never exponential notation. */
  toString(): string {
    return `${this.amount.toFixed()} ${this.currency}`;
  }

  /** Amount as a string, for the database and the wire. Never a number (ADR-0006). */
  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.amount.toFixed(), currency: this.currency };
  }
}
