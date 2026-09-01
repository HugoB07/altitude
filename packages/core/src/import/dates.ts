import { ledgerDate, type LedgerDate } from '@altitude/shared';

/**
 * Reading a date column, deciding the order once for the whole column.
 *
 * `03/04/2026` is the third of April in France and the fourth of March in the
 * United States, and no single value says which. Deciding per value is how a
 * file ends up with eleven days of every month read one way and the rest the
 * other - a ledger that is right about most of a year and silently wrong about
 * the twelfth of it.
 *
 * So the column decides. If any value in it has a first group above twelve, the
 * order is settled for every value; if none does, the file is ambiguous and
 * says so rather than guessing (§8.3).
 */

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

export interface ColumnFormat {
  readonly order: DateOrder;
  /**
   * True when nothing in the column proved the order and `order` is a default.
   *
   * The screen has to ask. A guess that is right for a French export and wrong
   * for an American one is a guess that moves transactions by up to eleven
   * months without looking wrong.
   */
  readonly ambiguous: boolean;
}

const SLASHED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day out of a value that may carry a time.
 *
 * `2026-08-22 07:32:08` and `2026-08-22T07:32:08Z` are what a modern export
 * writes, and neither matches a pattern anchored at the end of the string. Read
 * by a matcher that required a bare date, a whole column stopped looking like
 * dates at all: the screen then asked whether 03/04 was March or April, about a
 * file where every value said the year first.
 *
 * The time is discarded rather than used. An accounting date is a calendar day
 * (ADR-0006), and an instant late on the 31st is the 1st in half the world.
 */
export function dayPart(value: string): string {
  return value.trim().split(/[T ]/)[0] ?? '';
}

/**
 * Decides how a whole column is written.
 *
 * ISO wins outright: `2026-04-03` cannot be anything else, and a column of them
 * is never ambiguous. Otherwise the first group is examined across every value,
 * and one above twelve settles it - a day. A first group that is never above
 * twelve leaves the column genuinely undecidable, and `ambiguous` says so.
 *
 * The default when nothing decides is day-first. This application is bilingual
 * with a French half (ADR-0010), the presets it will grow are French banks, and
 * a European statement is what somebody is most likely to be holding.
 */
export function detectDateOrder(values: readonly string[]): ColumnFormat {
  const written = values.map(dayPart).filter((value) => value !== '');
  if (written.length === 0) return { order: 'dmy', ambiguous: true };

  if (written.every((value) => ISO.test(value))) return { order: 'ymd', ambiguous: false };

  let firstAboveTwelve = false;
  let secondAboveTwelve = false;
  for (const value of written) {
    const match = SLASHED.exec(value);
    if (match === null) continue;
    if (Number(match[1]) > 12) firstAboveTwelve = true;
    if (Number(match[2]) > 12) secondAboveTwelve = true;
  }

  // Both above twelve is not a date column at all, and saying "day first"
  // about it would be an answer to a question that has none.
  if (firstAboveTwelve && !secondAboveTwelve) return { order: 'dmy', ambiguous: false };
  if (secondAboveTwelve && !firstAboveTwelve) return { order: 'mdy', ambiguous: false };
  return { order: 'dmy', ambiguous: true };
}

/**
 * Reads one value, in the order the column was found to use.
 *
 * Two-digit years are read as this century. Bank exports do not go back to
 * 1926, and the alternative - a pivot year - is a rule nobody remembers and
 * that quietly stops being right.
 */
export function readDate(value: string, order: DateOrder): LedgerDate | null {
  const text = dayPart(value);

  const iso = ISO.exec(text);
  if (iso !== null) return build(iso[1]!, iso[2]!, iso[3]!);

  const match = SLASHED.exec(text);
  if (match === null) return null;

  const [, first, second, rawYear] = match;
  const year = rawYear!.length === 2 ? `20${rawYear!}` : rawYear!;

  if (order === 'ymd') return build(year, first!, second!);
  return order === 'dmy' ? build(year, second!, first!) : build(year, first!, second!);
}

/** `ledgerDate` rejects an impossible day, so 31/02 fails here rather than becoming 3 March. */
function build(year: string, month: string, day: string): LedgerDate | null {
  try {
    return ledgerDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  } catch {
    return null;
  }
}
