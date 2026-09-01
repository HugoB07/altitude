import { dec } from '@altitude/shared';
import { readCurrency } from './currencies';
import { sniffDelimiter, findHeaderRow, parseDelimited } from './csv';
import { dayPart, detectDateOrder, readDate, type DateOrder } from './dates';
import { fromDebitCredit, parseAmount } from './numbers';
import type { Candidate, CandidateEntry, ImportProblem, ImportReading } from './types';

/**
 * Reading a statement from a description of its columns.
 *
 * The other kind of reader is code, and Trade Republic is why: an export that
 * splits one transfer across two rows, or carries an ISIN and a quantity, is
 * not something any arrangement of column names describes. A bank statement is
 * the opposite - one row is one movement on one account - and describing it is
 * enough.
 *
 * That difference decides who can add a bank. A mapping is data, so it can be
 * written on screen by whoever holds the file, kept for next time, and shipped
 * in the repository for a bank nobody here has an account with. Same object
 * either way: what changes is where it came from, not what it is.
 *
 * The counterpart is `EXTERNAL`, as everywhere else. A statement says money
 * arrived; it never says from where, and the preview asks.
 */

/** The label for the account the statement is about. Bound on the preview screen. */
export const STATEMENT_ACCOUNT = 'ACCOUNT';
export const STATEMENT_COUNTERPART = 'EXTERNAL';

export interface ColumnMapping {
  /**
   * Which column is what, by header name.
   *
   * By name rather than by position, because a bank that inserts a column
   * should not silently shift every field by one - a mapping that reads the
   * date out of the value-date column produces a plausible file, not an error.
   */
  readonly columns: {
    readonly bookedOn: string;
    readonly description?: string;
    /** One column carrying a signed amount. Mutually exclusive with the pair below. */
    readonly amount?: string;
    /** Two columns, both written positive. See `fromDebitCredit`. */
    readonly debit?: string;
    readonly credit?: string;
    /** A currency per row, for a statement that mixes them. */
    readonly currency?: string;
    /** The bank's own identifier, which is what makes a second import add nothing. */
    readonly externalId?: string;
    /**
     * A column saying whether the row happened.
     *
     * A statement lists more than movements: a card payment that was reverted,
     * an authorisation that never settled, a transfer that was refused. They
     * are rows, they carry an amount, and importing them puts money in the
     * ledger that never moved.
     */
    readonly status?: string;
  };

  /**
   * Values of the status column whose rows did not happen.
   *
   * A list of what to leave out rather than a list of what to keep. A statement
   * that grows a new status would, under a keep-list, silently stop importing
   * real transactions - and losing a movement is the failure this whole reader
   * is built to avoid. An unknown status is imported and can be reversed; a
   * dropped one is found months later, if at all.
   *
   * What is left out is reported, so nothing disappears without saying so.
   */
  readonly skipStatuses?: readonly string[];

  /** The currency of every row, when the file has no column for it. */
  readonly currency?: string;
  /** Fixed rather than sniffed, when a file defeats the sniffer. */
  readonly delimiter?: string;
  /** Fixed rather than found, when the header is not where stability says. */
  readonly headerRow?: number;
  /**
   * Fixed rather than detected.
   *
   * `detectDateOrder` answers for most columns and says `ambiguous` for the
   * rest. This is where the answer to that question is recorded, so it is asked
   * once rather than on every import of the same bank.
   */
  readonly dateOrder?: DateOrder;
}

/** What a file looks like before anyone has said which column is what. */
export interface FileShape {
  readonly delimiter: string;
  readonly headerRow: number;
  readonly headers: readonly string[];
  /** The first few rows, for a person to recognise their statement by. */
  readonly sample: readonly (readonly string[])[];
  /** What the dates look like, and whether anything in them settled the order. */
  readonly dates: Readonly<Record<string, { order: DateOrder; ambiguous: boolean }>>;
  /**
   * Columns holding a handful of repeated values, and which values.
   *
   * A status column is one of these - TERMINE, RENVOYE, EN ATTENTE - and it is
   * how the screen offers the ones to leave out without anybody typing them.
   * Guessed from shape rather than from a name, since the column is called
   * "Etat" in one export and "Status" in the next.
   */
  readonly categories: Readonly<Record<string, readonly string[]>>;
}

/**
 * Everything that can be known about a file without being told anything.
 *
 * Fed to the mapping screen, which is otherwise asking somebody to describe a
 * file it could have described itself. The date order is worked out per column
 * because only one of them is the booking date and the screen does not know
 * which yet.
 */
export function readShape(text: string, mapping?: Pick<ColumnMapping, 'delimiter'>): FileShape {
  const delimiter = mapping?.delimiter ?? sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const headerRow = findHeaderRow(rows);
  const headers = rows[headerRow] ?? [];
  const body = rows.slice(headerRow + 1).filter((row) => row.some((cell) => cell.trim() !== ''));

  const dates: Record<string, { order: DateOrder; ambiguous: boolean }> = {};
  for (const [index, name] of headers.entries()) {
    const column = body.map((row) => row[index] ?? '');
    // Only columns that look like dates at all. Running the detector over an
    // amount column would answer a question nobody asked, in a way that looks
    // like an answer.
    // The day part, so a value carrying a time still counts as a date.
    if (!column.some((value) => /^\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(dayPart(value)))) continue;
    dates[name] = detectDateOrder(column);
  }

  const categories: Record<string, readonly string[]> = {};
  for (const [index, name] of headers.entries()) {
    if (name.trim() === '' || dates[name] !== undefined) continue;

    const values = new Set<string>();
    for (const row of body) {
      const cell = (row[index] ?? '').trim();
      if (cell !== '') values.add(cell);
      // More than a handful and it is a description or an amount, not a state.
      // Stopped early rather than counted: a file of forty thousand rows has
      // no reason to build a set of forty thousand descriptions.
      if (values.size > CATEGORY_LIMIT) break;
    }

    // One value is a constant, not a choice - a column saying "EUR" on every
    // row is not something to ask about. And a column of numbers is an amount
    // or a fee, however few distinct ones a short file happens to hold.
    const numeric = [...values].every((value) => parseAmount(value) !== null);
    if (values.size >= 2 && values.size <= CATEGORY_LIMIT && !numeric) {
      categories[name] = [...values].sort((a, b) => a.localeCompare(b));
    }
  }

  return { delimiter, headerRow, headers, sample: body.slice(0, 5), dates, categories };
}

/** Above this a column is describing rows, not classifying them. */
const CATEGORY_LIMIT = 8;

/**
 * Reads a statement into candidate transactions.
 *
 * One row is one transaction with two entries: the account the statement is
 * about, and the outside world. A row it cannot read becomes a problem naming
 * its line rather than being dropped - a reader that quietly skips rows costs
 * somebody a month they only find months later, and the plan is explicit that
 * one bad date must not stop the other three hundred and ninety-nine (§8.2).
 */
export function readMapped(text: string, mapping: ColumnMapping): ImportReading {
  const delimiter = mapping.delimiter ?? sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const headerRow = mapping.headerRow ?? findHeaderRow(rows);
  const header = rows[headerRow] ?? [];

  const problems: ImportProblem[] = [];
  const missing = requiredColumns(mapping).filter((name) => !header.includes(name));
  if (missing.length > 0) {
    return {
      candidates: [],
      accounts: [],
      securities: [],
      counterparts: [],
      problems: [{ line: headerRow + 1, reason: `This file has no ${missing.join(', ')} column` }],
      skipped: [],
    };
  }

  // Keyed from the rows already parsed. Re-joining them into text to parse a
  // second time loses the first cell that contains the delimiter.
  const records = rows
    .slice(headerRow + 1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));

  const order = mapping.dateOrder ?? decideOrder(records, mapping.columns.bookedOn);

  // Compared without case or accents: a file writes RENVOYE, Renvoyé and
  // renvoyé, and none of them is a different status.
  const skip = new Set((mapping.skipStatuses ?? []).map(fold));

  const candidates: Candidate[] = [];
  const skipped: ImportProblem[] = [];
  for (const [index, row] of records.entries()) {
    // Counting the header and any junk above it, so the number matches what a
    // spreadsheet shows rather than an offset into an array.
    const line = headerRow + index + 2;

    const status = (row[mapping.columns.status ?? ''] ?? '').trim();
    if (status !== '' && skip.has(fold(status))) {
      skipped.push({ line, reason: status, row });
      continue;
    }

    const bookedOn = readDate(row[mapping.columns.bookedOn] ?? '', order);
    if (bookedOn === null) {
      problems.push({
        line,
        reason: `Unreadable date "${row[mapping.columns.bookedOn] ?? ''}"`,
        row,
      });
      continue;
    }

    const amount = readAmount(row, mapping);
    if (amount === null) {
      problems.push({ line, reason: 'Unreadable amount', row });
      continue;
    }

    const currency = (
      mapping.columns.currency === undefined
        ? (mapping.currency ?? '')
        : (row[mapping.columns.currency] ?? '')
    ).trim();
    if (currency === '') {
      problems.push({ line, reason: 'No currency for this row, and none set', row });
      continue;
    }
    // Read here rather than at the ledger's door. A "€" in a currency column
    // used to pass the preview and throw on the way into the database, after
    // somebody had approved every line, with nothing said about which one
    // carried it.
    const code = readCurrency(currency);
    if (code === null) {
      problems.push({ line, reason: `Unreadable currency "${currency}"`, row });
      continue;
    }

    const description = (row[mapping.columns.description ?? ''] ?? '').trim();
    const externalId = (row[mapping.columns.externalId ?? ''] ?? '').trim();
    candidates.push({
      ...(externalId === '' ? {} : { externalId }),
      bookedOn,
      // What the statement shows, from the account's point of view. Nothing in
      // a bank export says an incoming transfer came from another account of
      // yours; that is what the counterpart control on the preview is for.
      kind: amount.isNegative() ? 'withdrawal' : 'deposit',
      ...(description === '' ? {} : { description }),
      sourceLines: [line],
      entries: [
        entry(STATEMENT_ACCOUNT, amount.toFixed(), code),
        entry(STATEMENT_COUNTERPART, amount.negated().toFixed(), code),
      ],
    });
  }

  return {
    candidates,
    accounts: candidates.length === 0 ? [] : [STATEMENT_ACCOUNT],
    securities: [],
    counterparts: candidates.length === 0 ? [] : [STATEMENT_COUNTERPART],
    problems,
    skipped,
  };
}

/** Whether a file has the columns a mapping names, without reading any of it. */
export function mappingFits(text: string, mapping: ColumnMapping): boolean {
  const delimiter = mapping.delimiter ?? sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const header = rows[mapping.headerRow ?? findHeaderRow(rows)] ?? [];
  return requiredColumns(mapping).every((name) => header.includes(name));
}

function requiredColumns(mapping: ColumnMapping): string[] {
  const { bookedOn, amount, debit, credit } = mapping.columns;
  if (amount !== undefined) return [bookedOn, amount];
  if (debit !== undefined && credit !== undefined) return [bookedOn, debit, credit];
  return [bookedOn];
}

function readAmount(
  row: Readonly<Record<string, string>>,
  mapping: ColumnMapping,
): ReturnType<typeof dec> | null {
  const { amount, debit, credit } = mapping.columns;

  if (amount !== undefined) return parseAmount(row[amount] ?? '')?.value ?? null;
  if (debit !== undefined && credit !== undefined) {
    return fromDebitCredit(row[debit] ?? '', row[credit] ?? '')?.value ?? null;
  }
  return null;
}

/** The order the whole column uses, decided once. See `detectDateOrder`. */
function decideOrder(
  records: readonly Readonly<Record<string, string>>[],
  column: string,
): DateOrder {
  return detectDateOrder(records.map((row) => row[column] ?? '')).order;
}

/** Case and accents removed, so RENVOYE and renvoyé are one status. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

function entry(account: string, amount: string, currency: string): CandidateEntry {
  // Normalised through Decimal, so "45,00" already turned into "45" reads the
  // same as "45.0000" from another file.
  return { account, amount: dec(amount).toFixed(), currency };
}

/**
 * A mapping as it arrives from outside, checked before anything trusts it.
 *
 * The screen sends this, and a stored one comes back out of the database, so
 * it is input in both directions. Nothing here is expensive - it is a handful
 * of strings - and the cost of not doing it is a reader indexing rows by
 * `undefined` and reporting every line as unreadable.
 *
 * Hand-written rather than a schema library. `packages/core` takes a dependency
 * only with a reason (CONTRIBUTING), and thirty lines that read like the type
 * they check is a poor reason.
 */
export function parseMapping(value: unknown): ColumnMapping | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const columns = raw['columns'];
  if (typeof columns !== 'object' || columns === null) return null;
  const cols = columns as Record<string, unknown>;

  const named = (key: string): string | undefined => {
    const found = cols[key];
    return typeof found === 'string' && found.trim() !== '' ? found : undefined;
  };

  const bookedOn = named('bookedOn');
  if (bookedOn === undefined) return null;

  const amount = named('amount');
  const debit = named('debit');
  const credit = named('credit');

  // One column or two, never both and never neither. A mapping with an amount
  // column and a debit column describes two different files.
  const oneColumn = amount !== undefined && debit === undefined && credit === undefined;
  const twoColumns = amount === undefined && debit !== undefined && credit !== undefined;
  if (!oneColumn && !twoColumns) return null;

  const order = raw['dateOrder'];
  if (order !== undefined && order !== 'dmy' && order !== 'mdy' && order !== 'ymd') return null;

  const headerRow = raw['headerRow'];
  if (headerRow !== undefined && (typeof headerRow !== 'number' || !Number.isInteger(headerRow))) {
    return null;
  }

  const skipRaw = raw['skipStatuses'];
  const skipStatuses = Array.isArray(skipRaw)
    ? skipRaw.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : undefined;

  const currency = typeof raw['currency'] === 'string' ? raw['currency'].trim() : undefined;
  const delimiter = typeof raw['delimiter'] === 'string' ? raw['delimiter'] : undefined;

  return {
    columns: {
      bookedOn,
      ...(named('description') === undefined ? {} : { description: named('description')! }),
      ...(amount === undefined ? {} : { amount }),
      ...(debit === undefined ? {} : { debit }),
      ...(credit === undefined ? {} : { credit }),
      ...(named('currency') === undefined ? {} : { currency: named('currency')! }),
      ...(named('externalId') === undefined ? {} : { externalId: named('externalId')! }),
      ...(named('status') === undefined ? {} : { status: named('status')! }),
    },
    ...(skipStatuses === undefined || skipStatuses.length === 0 ? {} : { skipStatuses }),
    ...(currency === undefined || currency === '' ? {} : { currency }),
    ...(delimiter === undefined ? {} : { delimiter }),
    ...(headerRow === undefined ? {} : { headerRow: headerRow as number }),
    ...(order === undefined ? {} : { dateOrder: order }),
  };
}

/**
 * What identifies a file's shape, so a mapping written once can be found again.
 *
 * The header row and the delimiter, and nothing else. Two exports from the same
 * bank differ in every row and agree on those, which is exactly the property a
 * key needs here.
 *
 * Not a hash. A hash would be shorter and would make a stored row unreadable,
 * and there is nothing to hide: a fingerprint holds column names, which say
 * which bank a file came from and nothing about what is in it. Being able to
 * look at the table and see why a mapping did or did not match is worth more
 * than the bytes it saves.
 *
 * A renamed column breaks the match, and should: a bank that renames one has
 * changed the question, and answering it with the old mapping would read the
 * value date as the booking date without saying so.
 */
export function fingerprintOf(text: string, delimiter?: string): string {
  const separator = delimiter ?? sniffDelimiter(text);
  const rows = parseDelimited(text, separator);
  const header = rows[findHeaderRow(rows)] ?? [];

  // A unit separator, because a column name can hold anything a person can
  // type - including whatever character was picked as a joiner.
  return [separator, ...header.map((name) => name.trim())].join('');
}
