import type { Brand } from './brand.js';

/**
 * A calendar date with no time and no timezone, as `YYYY-MM-DD`.
 *
 * Accounting dates are not instants. A transaction booked on 1 March is booked on
 * 1 March in Paris and in Tokyo alike. Storing one as a `Date` invites the classic
 * off-by-one-day bug: `new Date('2026-03-01')` is midnight UTC, which formats as
 * 28 February for anyone west of Greenwich, and the transaction silently moves to
 * the previous month — taking the monthly report with it.
 *
 * The database column is `date`, not `timestamptz`, for the same reason (plan §4.2).
 */
export type LedgerDate = Brand<string, 'LedgerDate'>;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function ledgerDate(value: string): LedgerDate {
  const match = DATE_RE.exec(value);
  if (match === null) {
    throw new TypeError(
      `Invalid ledger date: expected YYYY-MM-DD, received ${JSON.stringify(value)}.`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Rejects 2026-02-30 and friends. Built in UTC purely as a calendar calculator;
  // the value itself never becomes a Date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  const valid =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;

  if (!valid) {
    throw new TypeError(`Invalid ledger date: ${value} is not a real calendar date.`);
  }
  return value as LedgerDate;
}

/** Lexicographic order is chronological order for `YYYY-MM-DD`. */
export function compareDates(a: LedgerDate, b: LedgerDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Today in the given IANA timezone, defaulting to the system's. */
export function todayIn(timeZone?: string): LedgerDate {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD, which is what we want without reassembling parts.
  return ledgerDate(formatter.format(new Date()));
}
