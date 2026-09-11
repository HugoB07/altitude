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
 *
 * The column decides the year too, when the bank did not write one. A French
 * statement routinely dates its rows `13.08` and puts the year once, in the
 * letterhead - which is a block this never sees, because a PDF's letterhead is
 * not part of its table. So the year is read out of the only thing the column
 * itself proves: a statement runs forwards in time, and it has already
 * happened.
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
  /**
   * The year each yearless value belongs to, keyed by the value as written.
   *
   * A map rather than one number, because a statement that runs across New Year
   * needs two: December belongs to the year before the January under it, and
   * one year for the column moves eleven months of it by twelve. Keyed by the
   * text rather than by position, so a caller that skips a row - a reverted
   * card payment, say - does not shift every year after it by one.
   *
   * Inferred rather than asked for, and visible either way: every row's full
   * date is on the preview screen before anything is written, so a reader can
   * see that August is 2026 and not 2025.
   */
  readonly years?: ReadonlyMap<string, number>;
}

const SLASHED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `13.08`, which is what a statement writes when the year is in its letterhead. */
const YEARLESS = /^(\d{1,2})[/.-](\d{1,2})$/;

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
export function detectDateOrder(values: readonly string[], today = nowUtc()): ColumnFormat {
  const written = values.map(dayPart).filter((value) => value !== '');
  if (written.length === 0) return { order: 'dmy', ambiguous: true };

  if (written.every((value) => ISO.test(value))) return { order: 'ymd', ambiguous: false };

  let firstAboveTwelve = false;
  let secondAboveTwelve = false;
  for (const value of written) {
    const match = SLASHED.exec(value) ?? YEARLESS.exec(value);
    if (match === null) continue;
    if (Number(match[1]) > 12) firstAboveTwelve = true;
    if (Number(match[2]) > 12) secondAboveTwelve = true;
  }

  // Both above twelve is not a date column at all, and saying "day first"
  // about it would be an answer to a question that has none.
  const order: DateOrder = secondAboveTwelve && !firstAboveTwelve ? 'mdy' : 'dmy';
  const ambiguous = firstAboveTwelve === secondAboveTwelve;

  const years = yearsOf(written, order, today);

  return { order, ambiguous, ...(years === undefined ? {} : { years }) };
}

/**
 * The year a column of `13.08` belongs to.
 *
 * Two facts, and only two, and both are about the column rather than about any
 * bank: a statement runs forwards, and a statement is of movements that have
 * happened. So the months are walked in file order, a year is turned every time
 * one goes backwards - August to September to December to January - and the
 * whole run is then slid back until its last day is not in the future.
 *
 * Wrong on exactly one kind of file: a statement more than a year old, where
 * the run is slid one year too far forward. That is the wrong worth choosing,
 * because the alternative is a column of unreadable dates and a person typing a
 * statement in by hand, and because the answer is on the preview screen in full
 * before anything is written.
 *
 * `undefined` when every value carries its own year, which is every other
 * format Altitude reads.
 */
function yearsOf(
  written: readonly string[],
  order: DateOrder,
  today: string,
): ReadonlyMap<string, number> | undefined {
  const days: { text: string; day: number; month: number; turns: number }[] = [];

  let turns = 0;
  let previous: number | undefined;

  for (const text of written) {
    const match = YEARLESS.exec(text);
    if (match === null) continue;

    const first = Number(match[1]);
    const second = Number(match[2]);
    const { day, month } =
      order === 'dmy' ? { day: first, month: second } : { day: second, month: first };

    // Every time the months go backwards, a year turned under them.
    if (previous !== undefined && month < previous) turns += 1;
    previous = month;

    days.push({ text, day, month, turns });
  }

  const last = days[days.length - 1];
  if (last === undefined) return undefined;

  const [year = 0, month = 0, day = 0] = today.split('-').map(Number);
  const future = last.month > month || (last.month === month && last.day > day);
  const base = year - last.turns - (future ? 1 : 0);

  const years = new Map<string, number>();
  for (const one of days) {
    // The first reading of a value wins. A statement holding the same day and
    // month twice spans more than a year, which no statement does.
    if (!years.has(one.text)) years.set(one.text, base + one.turns);
  }

  return years;
}

/** Today, in UTC. A date column is a calendar day, and so is the line drawn under it. */
function nowUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reads one value, in the order the column was found to use.
 *
 * Two-digit years are read as this century. Bank exports do not go back to
 * 1926, and the alternative - a pivot year - is a rule nobody remembers and
 * that quietly stops being right.
 */
export function readDate(
  value: string,
  order: DateOrder,
  years?: ReadonlyMap<string, number>,
): LedgerDate | null {
  const text = dayPart(value);

  const iso = ISO.exec(text);
  if (iso !== null) return build(iso[1]!, iso[2]!, iso[3]!);

  const bare = YEARLESS.exec(text);
  if (bare !== null) {
    // Unreadable rather than guessed at one value's worth of evidence. The year
    // is a property of the column, worked out in `detectDateOrder`, and a
    // caller that did not carry it here has not asked the column.
    const assumed = years?.get(text);
    if (assumed === undefined) return null;
    return order === 'dmy'
      ? build(String(assumed), bare[2]!, bare[1]!)
      : build(String(assumed), bare[1]!, bare[2]!);
  }

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
