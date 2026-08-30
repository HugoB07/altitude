import { dec, ledgerDate, type LedgerDate } from '@altitude/shared';
import { parseRecords, sniffDelimiter } from './csv';
import type {
  Candidate,
  CandidateEntry,
  CandidateInstrument,
  EntryRole,
  ImportProblem,
  ImportReading,
} from './types';

/**
 * Trade Republic's transaction export.
 *
 * A coded preset rather than a column mapping, and the reason is worth stating
 * because it decides who can contribute a bank. Most statements are one row per
 * transaction, and a mapping - this column is the date, that one the amount -
 * covers them. This file is not that:
 *
 * - a transfer between two of your own accounts is two rows, one on each side,
 *   and they are one transaction
 * - a purchase carries an ISIN, a quantity and a price
 * - interest carries a tax that has already been deducted
 *
 * No arrangement of column names expresses any of that.
 *
 * The counterpart for money crossing the household's edge is the label
 * `EXTERNAL`, which the preview binds to a real account. The reader does not
 * decide which: it cannot know, and guessing would put a person's salary in
 * whichever account happened to sort first.
 */
export const EXTERNAL = 'EXTERNAL';

/**
 * The securities side of a trade on a given account.
 *
 * The file names one account for a purchase - `PEA`, `DEFAULT` - and means two
 * things by it: cash left the cash account and a holding arrived in the
 * securities account. Booking both to the same account made a purchase net to
 * zero on the cash account and put the shares nowhere anybody could see them.
 *
 * A derived label rather than a column, because there is no column. The preview
 * asks which of your accounts it is, exactly as it does for the ones the file
 * does name.
 */
export const SECURITIES_SUFFIX = ':SECURITIES';

export function securitiesLabel(account: string): string {
  return `${account}${SECURITIES_SUFFIX}`;
}

/**
 * The delimiter is not fixed, and finding that out cost an afternoon.
 *
 * The same broker exports semicolons from one place and commas from another,
 * quoting every field in the second case and not the first. A reader that
 * assumed either one parsed each line into a single field and reported "not a
 * Trade Republic export: no date, account_type, type, amount, currency" - which
 * is true of what it managed to read and useless as a description of the file.
 */
function delimiterOf(text: string): string {
  return sniffDelimiter(text);
}

/**
 * Columns that must exist for this to be a Trade Republic export.
 *
 * Checked before anything is read, so a file from another bank is refused with
 * "this does not look like a Trade Republic export" rather than producing four
 * hundred rows of nonsense that all have to be read to notice.
 */
const REQUIRED = ['date', 'account_type', 'type', 'amount', 'currency'] as const;

/** `asset_class` in the file, to something the instruments table understands. */
const KINDS: Record<string, string> = {
  STOCK: 'equity',
  FUND: 'fund',
  BOND: 'bond',
  CRYPTO: 'crypto',
};

/** The transaction kind each row type becomes in the ledger. */
const LEDGER_KINDS: Record<string, string> = {
  BUY: 'buy',
  SELL: 'sell',
  DIVIDEND: 'dividend',
  INTEREST_PAYMENT: 'interest',
  TRANSFER_IN: 'transfer',
  TRANSFER_OUT: 'transfer',
  TRANSFER_INSTANT_INBOUND: 'deposit',
  TRANSFER_INSTANT_OUTBOUND: 'withdrawal',
};

interface Row {
  readonly line: number;
  readonly data: Record<string, string>;
}

export function looksLikeTradeRepublic(text: string): boolean {
  const { header } = parseRecords(text, delimiterOf(text));
  return REQUIRED.every((name) => header.includes(name));
}

export function readTradeRepublic(text: string): ImportReading {
  const { header, records } = parseRecords(text, delimiterOf(text));

  const missing = REQUIRED.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    return {
      candidates: [],
      accounts: [],
      securities: [],
      counterparts: [],
      problems: [{ line: 1, reason: `Not a Trade Republic export: no ${missing.join(', ')}` }],
    };
  }

  // Line numbers count the header, so they match what a spreadsheet shows.
  const rows: Row[] = records.map((data, index) => ({ line: index + 2, data }));

  const problems: ImportProblem[] = [];
  const candidates: Candidate[] = [];
  const consumed = new Set<number>();

  // Transfers first, because pairing has to look across the whole file before
  // anything decides a row stands alone.
  for (const out of rows) {
    if (out.data['type'] !== 'TRANSFER_OUT' || consumed.has(out.line)) continue;

    const partner = rows.find(
      (row) =>
        !consumed.has(row.line) &&
        row.line !== out.line &&
        row.data['type'] === 'TRANSFER_IN' &&
        row.data['date'] === out.data['date'] &&
        row.data['currency'] === out.data['currency'] &&
        isOpposite(row.data['amount'], out.data['amount']),
    );
    if (partner === undefined) continue;

    consumed.add(out.line);
    consumed.add(partner.line);

    const date = toLedgerDate(out.data['date']);
    if (date === null) {
      problems.push({ line: out.line, reason: 'Unreadable date', row: out.data });
      continue;
    }

    candidates.push({
      ...externalId(out.data),
      bookedOn: date,
      kind: 'transfer',
      ...describe(out.data),
      sourceLines: [out.line, partner.line],
      entries: [
        line(out.data['account_type'] ?? '', out.data['amount'] ?? '', out.data['currency'] ?? ''),
        line(
          partner.data['account_type'] ?? '',
          partner.data['amount'] ?? '',
          partner.data['currency'] ?? '',
        ),
      ],
    });
  }

  for (const row of rows) {
    if (consumed.has(row.line)) continue;
    const built = single(row);
    if ('reason' in built) problems.push({ line: row.line, reason: built.reason, row: row.data });
    else candidates.push(built);
  }

  // Newest last, and stable: a preview that reorders rows is a preview nobody
  // can check against the file they are holding.
  candidates.sort((a, b) => (a.sourceLines[0] ?? 0) - (b.sourceLines[0] ?? 0));

  // Three lists, because the preview asks about them differently: an account
  // of the file has one answer, so does its securities side, and the outside
  // world has one per transaction.
  const accounts: string[] = [];
  const securities: string[] = [];
  const counterparts: string[] = [];
  for (const candidate of candidates) {
    for (const entry of candidate.entries) {
      const into =
        entry.account === EXTERNAL
          ? counterparts
          : entry.account.endsWith(SECURITIES_SUFFIX)
            ? securities
            : accounts;
      if (!into.includes(entry.account)) into.push(entry.account);
    }
  }

  return { candidates, accounts, securities, counterparts, problems };
}

/** One row that is a transaction on its own. */
function single(row: Row): Candidate | { reason: string } {
  const data = row.data;
  const type = data['type'] ?? '';
  const account = data['account_type'] ?? '';
  const currency = data['currency'] ?? '';
  const amount = data['amount'] ?? '';

  const date = toLedgerDate(data['date']);
  if (date === null) return { reason: 'Unreadable date' };
  if (!isDecimal(amount)) return { reason: `Unreadable amount "${amount}"` };

  const kind = LEDGER_KINDS[type] ?? 'adjustment';
  const common = {
    ...externalId(data),
    bookedOn: date,
    kind,
    ...describe(data),
    sourceLines: [row.line],
  };

  if (type === 'BUY' || type === 'SELL') {
    const instrument = toInstrument(data);
    if (instrument === null) return { reason: `A ${type} row with no instrument to attach it to` };
    const quantity = data['shares'] ?? '';
    if (!isDecimal(quantity)) return { reason: `Unreadable quantity "${quantity}"` };

    // Cash leaves, the holding arrives, and the two sum to nothing - which is
    // what makes a purchase not change net worth. The price per share is kept
    // as the file gave it rather than divided out of the total, so a rounding
    // difference stays where it was rather than being invented here.
    return {
      ...common,
      entries: [
        line(account, amount, currency),
        {
          ...line(securitiesLabel(account), negate(amount), currency),
          quantity: type === 'BUY' ? quantity : negate(quantity),
          ...(isDecimal(data['price'] ?? '') ? { unitPrice: data['price'] } : {}),
          instrument,
        },
      ],
    };
  }

  // Interest and dividends arrive with tax already deducted: `amount` is the
  // gross and `tax` is what was taken, so the cash actually credited is their
  // sum. Written as two lines rather than one net figure, because a tax folded
  // into a total is a tax nobody can report on later.
  //
  // Three lines, and the third is the one people ask about. The account earned
  // the gross and paid the tax - two movements - so double entry needs one
  // counterpart for what is left, which is the net that actually arrived. It is
  // labelled as such: an unexplained third figure on an interest payment reads
  // as an error, and was reported as one.
  //
  // Splitting it into two pairs was tried and rejected. It balances too, and it
  // turns one credit into four rows nobody asked for.
  const tax = data['tax'] ?? '';
  if (isDecimal(tax) && !dec(tax).isZero()) {
    const net = dec(amount).plus(dec(tax));
    return {
      ...common,
      entries: [
        line(account, amount, currency, 'gross'),
        line(account, tax, currency, 'withholdingTax'),
        line(EXTERNAL, negate(net.toFixed()), currency, 'netCredited'),
      ],
    };
  }

  return {
    ...common,
    entries: [line(account, amount, currency), line(EXTERNAL, negate(amount), currency)],
  };
}

function line(account: string, amount: string, currency: string, role?: EntryRole): CandidateEntry {
  return {
    account,
    // Normalised through Decimal so "0.730000" and "0.73" are the same value,
    // and so anything that is not a number fails here rather than at the
    // database.
    amount: dec(amount).toFixed(),
    currency,
    // A token, not a sentence. The reader has no language.
    ...(role === undefined ? {} : { role }),
  };
}

function toInstrument(data: Record<string, string>): CandidateInstrument | null {
  const name = (data['name'] ?? '').trim();
  const isin = (data['symbol'] ?? '').trim();
  if (name === '' && isin === '') return null;

  return {
    // The column is called `symbol` and contains an ISIN. Named for what it
    // holds rather than for what the exporter calls it.
    ...(isin === '' ? {} : { isin }),
    name: name === '' ? isin : name,
    currency: data['currency'] ?? 'EUR',
    kind: KINDS[data['asset_class'] ?? ''] ?? 'other',
  };
}

function describe(data: Record<string, string>): { description?: string } {
  const text = (data['description'] ?? '').trim();
  return text === '' ? {} : { description: text };
}

/**
 * The provider's id, when the export carries one.
 *
 * Anonymised exports replace it with a constant, which would make every row
 * look like the same transaction and collapse an entire import into one. A
 * value shared by more than one row is no identifier, so this only trusts it
 * when the file is not obviously scrubbed.
 */
function externalId(data: Record<string, string>): { externalId?: string } {
  const id = (data['transaction_id'] ?? '').trim();
  if (id === '' || id.toLowerCase() === 'anonyme' || id.toLowerCase() === 'anonymised') return {};
  return { externalId: id };
}

/**
 * The accounting day, written either way this exporter writes it.
 *
 * `DD/MM/YYYY` in one export and `YYYY-MM-DD` in another. Both are read here
 * rather than guessed at, because the two are ambiguous for eleven days of
 * every month and a wrong guess moves a transaction by up to a year without
 * looking wrong on screen.
 *
 * The `datetime` column beside it is deliberately unused: it is an instant in
 * UTC, and an instant late on the 31st is the 1st in half the world (ADR-0006's
 * argument about dates, which is why the column is a `date`).
 */
function toLedgerDate(value: string | undefined): LedgerDate | null {
  const text = (value ?? '').trim();

  const european = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  const parts =
    european !== null
      ? { year: european[3]!, month: european[2]!, day: european[1]! }
      : iso !== null
        ? { year: iso[1]!, month: iso[2]!, day: iso[3]! }
        : null;
  if (parts === null) return null;

  try {
    return ledgerDate(`${parts.year}-${parts.month}-${parts.day}`);
  } catch {
    // A well-formed 31/02 is caught here rather than becoming the 3rd of March.
    return null;
  }
}

function isDecimal(value: string): boolean {
  if (value.trim() === '') return false;
  try {
    return !dec(value.trim()).isNaN();
  } catch {
    return false;
  }
}

function negate(value: string): string {
  return dec(value).negated().toFixed();
}

function isOpposite(a: string | undefined, b: string | undefined): boolean {
  if (!isDecimal(a ?? '') || !isDecimal(b ?? '')) return false;
  return dec(a!).plus(dec(b!)).isZero();
}
