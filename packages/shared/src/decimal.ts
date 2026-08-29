import { Decimal } from 'decimal.js';

/**
 * The single configuration point for decimal arithmetic (ADR-0006).
 *
 * No other module may configure `Decimal` or construct its own constructor: two
 * different precisions in one process produce results that disagree depending on
 * which module happened to run first.
 *
 * - `precision: 40` significant digits comfortably covers the widest column in
 *   the schema, `numeric(38,18)`, with room for intermediate results.
 * - `ROUND_HALF_EVEN` — banker's rounding. Half-up biases every tie upwards, and
 *   over a long series of roundings that bias accumulates in one direction.
 *   Half-even splits ties between up and down, so the error cancels out.
 * - `toExpNeg`/`toExpPos` are pushed out of range so `toString()` never produces
 *   exponential notation. `1e-9` reaching the database as a literal would be
 *   rejected, and reaching a CSV export would be unreadable.
 */
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

export { Decimal };

/** Anything accepted as a decimal input. Deliberately excludes `number`. */
export type DecimalInput = string | Decimal;

/**
 * Builds a Decimal, refusing `number` at runtime as well as at compile time.
 *
 * The type signature already excludes `number`, but values arriving from JSON,
 * a form or an untyped import are `any` at the boundary — which is exactly where
 * a float would slip in unnoticed. Hence the runtime guard.
 */
export function dec(value: DecimalInput): Decimal {
  if (typeof value === 'number') {
    throw new TypeError(
      'Refusing to build a Decimal from a number: pass a string instead (ADR-0006). ' +
        `Received ${String(value)}.`,
    );
  }
  return value instanceof Decimal ? value : new Decimal(value);
}

export const ZERO: Decimal = new Decimal(0);
