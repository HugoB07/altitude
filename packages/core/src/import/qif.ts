import { detectDateOrder, readDate, type DateOrder } from './dates';
import { STATEMENT_ACCOUNT, STATEMENT_COUNTERPART } from './mapped';
import { parseAmount } from './numbers';
import type { Candidate, CandidateEntry, ImportProblem, ImportReading } from './types';

/**
 * QIF, which is older than most of the banks still exporting it.
 *
 * The plan keeps it (§8.1) for one reason: it is still what several French
 * banks offer when the CSV is behind a paywall or absent. There is no
 * specification worth the name - Intuit stopped maintaining it - so this reads
 * the parts every writer agrees on and reports the rest rather than guessing.
 *
 * One letter per line names the field, `^` ends a record. What no writer agrees
 * on is the date, which is why the order is decided across the whole file the
 * way it is for a CSV column (§8.3): `03/04/2026` is ambiguous on its own and
 * settled by any row in the file whose first group is above twelve.
 *
 * The format carries no currency at all. The plan says it is asked for at
 * import time, so it arrives here as an argument rather than being guessed.
 */

/** The record types that are one row, one movement. `Invst` is not one of them. */
const READABLE = new Set(['bank', 'cash', 'ccard', 'oth a', 'oth l', 'card', 'credit card']);

export function looksLikeQif(text: string): boolean {
  return /^\s*!\s*(type|account|option|clear)/i.test(text);
}

interface QifRecord {
  readonly line: number;
  readonly fields: { readonly letter: string; readonly value: string }[];
}

export function readQif(text: string, currency: string): ImportReading {
  const { records, accounts, unreadable } = split(text);

  const problems: ImportProblem[] = [...unreadable];
  const candidates: Candidate[] = [];

  // Decided once for the file rather than per row. A file where some day is
  // above the twelfth has already answered, and reading each row on its own
  // would put half a statement in April and half in March.
  const order = detectDateOrder(records.map((record) => field(record, 'D'))).order;

  const label = accounts[0] ?? STATEMENT_ACCOUNT;

  for (const record of records) {
    const built = transaction(record, label, currency, order);
    if ('reason' in built) problems.push({ line: record.line, reason: built.reason });
    else candidates.push(built);
  }

  return {
    candidates,
    accounts: candidates.length === 0 ? [] : [label],
    securities: [],
    counterparts: candidates.length === 0 ? [] : [STATEMENT_COUNTERPART],
    problems,
    skipped: [],
  };
}

function transaction(
  record: QifRecord,
  account: string,
  currency: string,
  order: DateOrder,
): Candidate | { reason: string } {
  const raw = field(record, 'D');
  const bookedOn = readDate(raw, order);
  if (bookedOn === null) return { reason: `Unreadable date "${raw}"` };

  // `U` is the same number as `T`, written again for a version of Quicken that
  // wanted it. Either will do, and a file that has only one of them is common.
  const parsed = parseAmount(field(record, 'T') || field(record, 'U'));
  if (parsed === null) return { reason: `Unreadable amount "${field(record, 'T')}"` };
  const amount = parsed.value;

  // `P` is the payee field and holds the whole label in every French export
  // that has been looked at, so it is the description. Nothing here is filed as
  // who was on the other side: unlike OFX, the format has no separate field for
  // it, and a rule reads it out of the description instead (§8.6).
  const payee = field(record, 'P');
  const memo = field(record, 'M');
  const description = payee === '' ? memo : payee;

  // What the file carried that the description does not already say. The memo
  // first, then the cheque number - which is a payment reference and the one
  // thing a QIF holds that identifies a particular row. Not an `externalId`:
  // every bank numbers cheques from one, so it is unique to nobody.
  const reference = memo !== '' && memo !== description ? memo : field(record, 'N');

  const entry: CandidateEntry = {
    account,
    amount: amount.toFixed(),
    currency,
    ...(reference === '' ? {} : { memo: reference }),
  };

  return {
    bookedOn,
    kind: amount.isNegative() ? 'withdrawal' : 'deposit',
    ...(description === '' ? {} : { description }),
    sourceLines: [record.line],
    entries: [
      entry,
      { account: STATEMENT_COUNTERPART, amount: amount.negated().toFixed(), currency },
    ],
  };
}

/**
 * The file, as records and the account names it mentions.
 *
 * `!Type:` switches what the records below it are, and `!Account` introduces a
 * block naming one rather than a transaction - both are directives, and reading
 * them as records is what turns an account name into a transaction with no
 * date.
 */
function split(text: string): {
  records: QifRecord[];
  accounts: string[];
  unreadable: ImportProblem[];
} {
  const records: QifRecord[] = [];
  const accounts: string[] = [];
  const unreadable: ImportProblem[] = [];

  let current: QifRecord | null = null;
  let readable = true;
  let naming = false;

  const lines = text.split(/\r\n|\n|\r/);

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const contents = raw.trim();
    if (contents === '') continue;

    if (contents.startsWith('!')) {
      const directive = contents.slice(1).trim().toLowerCase();
      naming = directive.startsWith('account');

      if (directive.startsWith('type:')) {
        const type = directive.slice('type:'.length).trim();
        readable = READABLE.has(type);
        if (!readable) {
          // Named rather than skipped. An investment QIF is a real file this
          // cannot read, and silence would look like a file with no rows.
          unreadable.push({
            line,
            reason: `Only bank and card records are read, and this section is "${type}"`,
          });
        }
      }

      current = null;
      continue;
    }

    if (contents === '^') {
      if (current !== null && current.fields.length > 0) records.push(current);
      current = null;
      continue;
    }

    const letter = contents[0]!.toUpperCase();
    const value = contents.slice(1).trim();

    if (naming) {
      if (letter === 'N' && value !== '' && !accounts.includes(value)) accounts.push(value);
      continue;
    }

    if (!readable) continue;

    current ??= { line, fields: [] };
    current.fields.push({ letter, value });
  }

  // A last record whose `^` the writer forgot, which is common enough to
  // handle: dropping it loses a transaction and says nothing.
  if (current !== null && current.fields.length > 0) records.push(current);

  return { records, accounts, unreadable };
}

function field(record: QifRecord, letter: string): string {
  return record.fields.find((one) => one.letter === letter)?.value ?? '';
}
