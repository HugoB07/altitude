import { ledgerDate, type Decimal, type LedgerDate } from '@altitude/shared';
import { readCurrency } from './currencies';
import { STATEMENT_ACCOUNT, STATEMENT_COUNTERPART } from './mapped';
import { parseAmount } from './numbers';
import type {
  BalanceReading,
  Candidate,
  CandidateEntry,
  ImportProblem,
  ImportReading,
} from './types';

/**
 * MT940, the SWIFT statement.
 *
 * The plan's own description is "legacy SWIFT, still used by a few
 * institutions" and it is at the bottom of the v1 list (§8.1). That is the
 * right weight: nobody chooses MT940. It is what a bank offers when it offers
 * nothing else, and the reason to read it is that the alternative for that
 * person is typing their statement in by hand.
 *
 * A telex format, and it shows. Fields are `:NN:` tags on their own line, the
 * amount is a comma decimal, the year is two digits, and the booking date has
 * no year at all - it is four digits and borrows the year from the value date
 * beside it, which goes wrong once every December if nobody thinks about it.
 *
 * Two dialects of the narrative field. French banks write a sentence into
 * `:86:` and that is all there is. German ones write a structured record -
 * `?20` is remittance, `?32` is the other party's name - which is the only way
 * this format ever yields a counterparty, so both are read.
 */

export function looksLikeMt940(text: string): boolean {
  const head = text.slice(0, 4096);
  // A transaction reference and either a balance or a statement line. The
  // reference alone is too weak: `:20:` at the start of a line is something a
  // CSV of timestamps could produce.
  return /(^|\n):20:/.test(head) && /(^|\n):6[012][FM]?:/.test(head);
}

/** A `:NN:` field, with whatever continuation lines followed it. */
interface Field {
  readonly tag: string;
  readonly value: string;
  readonly line: number;
}

/** One `:61:` and the `:86:` that may follow it. */
interface Movement {
  readonly field: Field;
  narrative: string;
}

interface Statement {
  account: string;
  currency: string | null;
  closing: Decimal | null;
  readonly movements: Movement[];
}

export function readMt940(text: string): ImportReading {
  const statements = split(fields(text));
  const closing = balances(statements);

  const problems: ImportProblem[] = [];
  const candidates: Candidate[] = [];
  const accounts: string[] = [];

  for (const statement of statements) {
    if (!accounts.includes(statement.account)) accounts.push(statement.account);

    for (const movement of statement.movements) {
      const built = transaction(movement, statement);
      if ('reason' in built) problems.push({ line: movement.field.line, reason: built.reason });
      else candidates.push(built);
    }
  }

  return {
    candidates,
    accounts: candidates.length === 0 ? [] : accounts,
    securities: [],
    counterparts: candidates.length === 0 ? [] : [STATEMENT_COUNTERPART],
    problems,
    skipped: [],
    ...(closing === null ? {} : { balances: closing }),
  };
}

/**
 * The closing balance, when the file states one and holds one statement.
 *
 * `:62F:` is the final closing balance. `:62M:` is an intermediate one, which
 * appears when a statement is split across several messages, and reading it as
 * final would compare a ledger against the middle of a month.
 *
 * Omitted when the file holds several statements, for the reason OFX and CAMT
 * omit it: two closing balances on two accounts are not one number.
 */
function balances(statements: readonly Statement[]): BalanceReading | null {
  if (statements.length !== 1) return null;

  const statement = statements[0]!;
  if (statement.closing === null) return null;

  return {
    account: statement.account,
    closing: statement.closing.toFixed(),
    checked: 0,
    mismatches: [],
  };
}

/**
 * The statement line, which is one field holding eight values and no separators.
 *
 * `2601050105D42,10NMSCNONREF//2026010500001`, read left to right: value date,
 * booking date without its year, the direction, an optional funds code, the
 * amount, the transaction type, the customer's reference, and after the double
 * slash the bank's own.
 */
const LINE = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d.,]+)([A-Z][A-Z0-9]{3})?(.*)$/u;

function transaction(movement: Movement, statement: Statement): Candidate | { reason: string } {
  const [head = '', ...rest] = movement.field.value.split('\n');
  const found = LINE.exec(head.trim());
  if (found === null) return { reason: `Unreadable statement line ":61:${head.trim()}"` };

  const [, value = '', booking, mark = '', , written = '', type = '', trailing = ''] = found;

  const parsed = parseAmount(written);
  if (parsed === null) return { reason: `Unreadable amount "${written}"` };

  const currency = statement.currency;
  if (currency === null) {
    // `:60F:` is mandatory in the standard and carries the only currency in the
    // file. Guessing the household's would book dollars as euros at parity,
    // which is a loss nothing later can detect.
    return { reason: 'This statement states no currency, so its amounts have no meaning' };
  }

  const bookedOn = date(value, booking);
  if (bookedOn === null) return { reason: `Unreadable date "${value}${booking ?? ''}"` };

  const narrative = read86(movement.narrative, rest.join(' '));
  const amount = signed(parsed.value, mark);

  const entry: CandidateEntry = {
    account: statement.account,
    amount: amount.toFixed(),
    currency,
    ...(narrative.memo === '' ? {} : { memo: narrative.memo }),
  };

  const id = reference(trailing);

  return {
    ...(id === '' ? {} : { externalId: id }),
    bookedOn,
    kind: kind(type, amount.isNegative()),
    ...(narrative.description === '' ? {} : { description: narrative.description }),
    ...(narrative.counterparty === '' ? {} : { counterparty: narrative.counterparty }),
    sourceLines: [movement.field.line],
    entries: [
      entry,
      { account: STATEMENT_COUNTERPART, amount: amount.negated().toFixed(), currency },
    ],
  };
}

/**
 * The direction mark, which has four values rather than two.
 *
 * `C` and `D` are what everybody expects. `RC` and `RD` are reversals - an
 * entry cancelling an earlier one - and the letter after the R is the direction
 * of what is being cancelled, not of this line. Reading `RC` as a credit books
 * a refund as a second payment.
 */
function signed(amount: Decimal, mark: string): Decimal {
  const out = mark === 'D' || mark === 'RC';
  return out ? amount.abs().negated() : amount.abs();
}

/**
 * The day this was booked, from a six-digit date and a four-digit one.
 *
 * The value date carries `YYMMDD`; the booking date beside it carries `MMDD`
 * and borrows the year. Borrowing it naively is wrong exactly once a year: a
 * statement dated 2 January holds entries booked on 31 December, and taking
 * the value date's year files them eleven months into the future.
 *
 * Two digits for a year, and no century anywhere in the format. Read as 20YY,
 * because a bank still emitting MT940 in 2026 is not emitting 1998's statement.
 */
function date(value: string, entry: string | undefined): LedgerDate | null {
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));

  if (entry === undefined) return build(year, month, Number(value.slice(4, 6)));

  const entryMonth = Number(entry.slice(0, 2));
  const entryDay = Number(entry.slice(2, 4));

  // More than six months apart is a year boundary rather than a long delay: no
  // bank books an entry seven months after its value date.
  const shift = entryMonth - month > 6 ? -1 : month - entryMonth > 6 ? 1 : 0;

  return build(year + shift, entryMonth, entryDay) ?? build(year, month, Number(value.slice(4, 6)));
}

function build(year: number, month: number, day: number): LedgerDate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

  const written = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  try {
    return ledgerDate(written);
  } catch {
    // A well-formed 2026-02-31 is caught here rather than becoming 2 March.
    return null;
  }
}

/**
 * The bank's own reference, from what follows the double slash.
 *
 * `NONREF` is the standard's own word for "there isn't one" and appears on the
 * customer's side of most lines. As an external id it would make every entry in
 * a statement the same transaction, and deduplication would drop all but the
 * first - so it is refused here rather than found out later.
 */
const PLACEHOLDERS = new Set(['NONREF', 'NOTPROVIDED', 'NA', 'N/A', 'NONE', '0']);

function reference(trailing: string): string {
  const at = trailing.indexOf('//');
  const written = (at === -1 ? '' : trailing.slice(at + 2)).trim();
  return written === '' || PLACEHOLDERS.has(written.toUpperCase()) ? '' : written;
}

/**
 * The transaction kind, from the type code where it adds anything.
 *
 * `NTRF` is deliberately not mapped to a transfer. In SWIFT it means a credit
 * transfer, which is what a salary, a refund and a payment to a friend all
 * are - and the ledger's `transfer` means money moving between two of your own
 * accounts. Filing every incoming credit transfer as one would be wrong far
 * more often than right, and the sign already says what the ledger needs.
 */
function kind(type: string, negative: boolean): string {
  switch (type.toUpperCase()) {
    case 'NINT':
      return 'interest';
    case 'NDIV':
      return 'dividend';
    case 'NCHG':
    case 'NCOM':
      return 'fee';
    default:
      return negative ? 'withdrawal' : 'deposit';
  }
}

/**
 * The narrative, in both of the dialects banks write it in.
 *
 * A French statement puts a sentence in `:86:`. A German one puts a record:
 * `?00` is the booking text, `?20` through `?29` and `?60` through `?63` are
 * the remittance information split across lines of thirty-odd characters, and
 * `?32` with `?33` are the two halves of the other party's name.
 *
 * The structured form is the only place this format ever names a counterparty,
 * which is why it is worth reading rather than treating as one long string:
 * "how much at that shop this year" is a question no category can answer.
 */
function read86(
  narrative: string,
  supplementary: string,
): { description: string; counterparty: string; memo: string } {
  const text = narrative.trim();

  if (!text.includes('?')) {
    const description = collapse(text);
    const extra = collapse(supplementary);
    return {
      description: description === '' ? extra : description,
      counterparty: '',
      // Kept only when it says something the description does not. Repeated on
      // both, it is a second copy of the same sentence under every row.
      memo: extra === '' || extra === description ? '' : extra,
    };
  }

  const parts = new Map<string, string>();
  for (const match of text.matchAll(/\?(\d{2})([^?]*)/gu)) {
    const key = match[1]!;
    parts.set(key, (parts.get(key) ?? '') + (match[2] ?? ''));
  }

  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, at) => String(from + at).padStart(2, '0'))
      .map((key) => parts.get(key) ?? '')
      .join('');

  const remittance = collapse(`${range(20, 29)}${range(60, 63)}`);
  const booking = collapse(parts.get('00') ?? '');
  const counterparty = collapse(`${parts.get('32') ?? ''}${parts.get('33') ?? ''}`);

  return {
    description: remittance === '' ? booking : remittance,
    counterparty,
    memo: booking === '' || booking === remittance ? '' : booking,
  };
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The file, as `:NN:` fields.
 *
 * A line that opens with a tag starts a field; anything else continues the one
 * before it. That is the whole of the format's structure, and it is why a
 * narrative wrapped across four lines is one value rather than four.
 *
 * SWIFT's own envelope - `{1:...}{2:...}{4:` around the message and a lone `-`
 * closing it - is skipped rather than parsed. Nothing in it says anything about
 * money, and half the files in the wild have been unwrapped already.
 */
const TAG = /^:(\d{2}[A-Z]?):(.*)$/u;

function fields(text: string): Field[] {
  const found: Field[] = [];
  let current: { tag: string; parts: string[]; line: number } | null = null;

  const flush = () => {
    if (current !== null) {
      found.push({ tag: current.tag, value: current.parts.join('\n'), line: current.line });
    }
    current = null;
  };

  for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
    const line = raw.replace(/\r$/u, '');
    const match = TAG.exec(line.trim());

    if (match !== null) {
      flush();
      current = { tag: match[1]!, parts: [match[2] ?? ''], line: index + 1 };
      continue;
    }

    // SWIFT's own envelope: `{1:...}` blocks around the message and the `-}`
    // or lone `-` that closes it. Matched narrowly, because a narrative line
    // is free to start with a dash and dropping it loses half a label.
    const bare = line.trim();
    if (bare === '' || bare === '-' || bare === '-}' || /^\{\d:/u.test(bare)) continue;
    if (current === null) continue;

    current.parts.push(line);
  }

  flush();
  return found;
}

/**
 * The fields, grouped into the statements they belong to.
 *
 * `:20:` opens one. A file holding three months is three messages concatenated,
 * which is what a bank hands over when a statement is asked for by year, and
 * reading them as one would put every closing balance but the last out of reach.
 */
function split(all: readonly Field[]): Statement[] {
  const statements: Statement[] = [];
  let current: Statement | null = null;

  const open = (): Statement => {
    const made: Statement = {
      account: STATEMENT_ACCOUNT,
      currency: null,
      closing: null,
      movements: [],
    };
    statements.push(made);
    return made;
  };

  for (const field of all) {
    if (field.tag === '20') {
      current = open();
      continue;
    }

    current ??= open();

    switch (field.tag) {
      case '25': {
        // `30003/00012345678`, or an IBAN, or either followed by a currency.
        // Shown so a person can say which of their accounts it is, and never
        // written down: the binding it produces is an account id.
        const written = field.value.split('\n')[0]!.trim();
        if (written !== '') current.account = written;
        break;
      }
      case '60F':
      case '60M':
      case '62F':
      case '62M': {
        const balance = readBalance(field.value);
        if (balance === null) break;
        current.currency ??= balance.currency;
        // Only the final one. An intermediate closing balance is the middle of
        // a month, and reconciling a ledger against it reports a gap that is
        // not an error.
        if (field.tag === '62F' && balance.amount !== null) current.closing = balance.amount;
        break;
      }
      case '61':
        current.movements.push({ field, narrative: '' });
        break;
      case '86': {
        // Belongs to the statement rather than to a line when no line has been
        // read yet, which is where some banks put a message to the customer.
        const last = current.movements[current.movements.length - 1];
        if (last !== undefined) last.narrative = field.value;
        break;
      }
      default:
        break;
    }
  }

  return statements;
}

/**
 * `C260101EUR1758,63`: a direction, a date, a currency and an amount.
 *
 * The amount is deliberately not pinned down to digits and a comma. This field
 * is the only place in an MT940 file where the currency is written, so a
 * balance refused outright would leave every amount in the statement meaning
 * nothing - and the one thing writers get wrong here is exactly the amount,
 * by putting a minus in front of it that the standard says belongs in the
 * mark. Reading the currency has to survive that.
 */
const BALANCE = /^(RC|RD|C|D)(\d{6})([A-Z]{3})(.*)$/u;

function readBalance(value: string): { currency: string; amount: Decimal | null } | null {
  const found = BALANCE.exec(value.split('\n')[0]!.trim());
  if (found === null) return null;

  const currency = readCurrency(found[3] ?? '');
  if (currency === null) return null;

  // A balance carries a direction like any other amount: `D` here means the
  // account is overdrawn, and reading it unsigned reconciles an overdraft
  // against its own mirror image. The mark is what decides, so a sign written
  // into the amount as well is redundant rather than a second opinion.
  const parsed = parseAmount(found[4] ?? '');
  return { currency, amount: parsed === null ? null : signed(parsed.value, found[1] ?? 'C') };
}
