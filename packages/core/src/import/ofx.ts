import { ledgerDate, type LedgerDate } from '@altitude/shared';
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
 * OFX, both of the two things that name themselves OFX.
 *
 * The plan puts it in v1 and calls the mapping deterministic (§8.1): unlike a
 * CSV, the file says what every value is, so there is no screen to show and
 * nothing to remember between imports. That is the whole reason it is worth
 * having - a bank that exports OFX needs no preset, from anyone, ever.
 *
 * Two dialects under one name. 1.x is SGML: a header block of `KEY:VALUE`
 * lines, then tags where a leaf is never closed - `<TRNAMT>-42.10` and the
 * value ends at the next `<`. 2.x is XML and closes everything. They are read
 * by one tokeniser rather than two, because the difference is exactly one rule:
 * a tag holding text is a leaf, closed by its text. Applied to 2.x that makes
 * the `</TRNAMT>` redundant rather than wrong, so it is skipped and nothing
 * else has to know which dialect it is looking at.
 *
 * Written here rather than taken from a library, for the reason CONTRIBUTING
 * gives: `packages/core` takes a dependency with a reason, and an XML parser
 * would be one more thing to keep current for a format that has not changed
 * since 2003 - and one that would want configuring against entity expansion
 * (plan §8.7) rather than simply not having entities.
 */

export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 4096).toUpperCase();
  return head.includes('<OFX>') || head.includes('OFXHEADER');
}

/** A tag, its text if it is a leaf, and where it started. */
interface Node {
  readonly tag: string;
  value: string;
  readonly line: number;
  readonly children: Node[];
}

export function readOfx(text: string): ImportReading {
  const root = parse(text);

  const problems: ImportProblem[] = [];
  const candidates: Candidate[] = [];
  const accounts: string[] = [];

  const statements = [...deep(root, 'STMTRS'), ...deep(root, 'CCSTMTRS')];

  if (statements.length === 0) {
    // Said as its own sentence rather than as an empty result. A brokerage
    // export is a real OFX file that this cannot read yet, and "nothing to
    // import" would send somebody looking for a problem with their bank.
    const investment = deep(root, 'INVSTMTRS').length > 0;
    return {
      candidates: [],
      accounts: [],
      securities: [],
      counterparts: [],
      problems: [
        {
          line: 1,
          reason: investment
            ? 'This is an investment statement, and only bank and card statements are read'
            : 'This OFX file holds no bank or card statement',
        },
      ],
      skipped: [],
    };
  }

  for (const statement of statements) {
    const label = accountLabel(statement);
    if (!accounts.includes(label)) accounts.push(label);

    // The statement's own currency, and a transaction may override it. Both
    // are read rather than assumed: a file with no CURDEF and no per-row
    // currency is one whose amounts mean nothing, and guessing EUR would put
    // dollars in a euro account without a word.
    const fallback = value(statement, 'CURDEF');

    for (const found of deep(statement, 'STMTTRN')) {
      const built = transaction(found, label, fallback);
      if ('reason' in built) problems.push({ line: found.line, reason: built.reason });
      else candidates.push(built);
    }
  }

  candidates.sort((a, b) => (a.sourceLines[0] ?? 0) - (b.sourceLines[0] ?? 0));

  const closing = balances(statements);

  return {
    candidates,
    accounts,
    securities: [],
    counterparts: candidates.length === 0 ? [] : [STATEMENT_COUNTERPART],
    problems,
    skipped: [],
    ...(closing === null ? {} : { balances: closing }),
  };
}

/**
 * The account this statement is about, as the file names it.
 *
 * The account number, which is what a person recognises. It is shown so they
 * can say which of their accounts it is, and it is not written anywhere: the
 * binding it produces is an account id, and the label is gone with the request.
 *
 * A file holding two statements names two, which is the point - a CSV says
 * "ACCOUNT" and means whichever one the person had in mind.
 */
function accountLabel(statement: Node): string {
  const from = child(statement, 'BANKACCTFROM') ?? child(statement, 'CCACCTFROM');
  const id = from === undefined ? '' : value(from, 'ACCTID');
  return id === '' ? STATEMENT_ACCOUNT : id;
}

/**
 * The closing balance, when the file states one and states it once.
 *
 * `LEDGERBAL` is the balance after the last transaction, which is the half of
 * reconciling that OFX can support: there is no running balance per row, so
 * nothing to read back line by line, and `checked` says so honestly rather
 * than claiming a check that never ran.
 *
 * Omitted when the file holds several statements. Two closing balances on two
 * accounts are not one number, and picking either would compare the ledger
 * against half of what was imported.
 */
function balances(statements: readonly Node[]): BalanceReading | null {
  if (statements.length !== 1) return null;

  const statement = statements[0]!;
  const ledger = child(statement, 'LEDGERBAL');
  if (ledger === undefined) return null;

  const closing = parseAmount(value(ledger, 'BALAMT'));
  if (closing === null) return null;

  return {
    account: accountLabel(statement),
    closing: closing.value.toFixed(),
    checked: 0,
    mismatches: [],
  };
}

function transaction(
  found: Node,
  account: string,
  fallbackCurrency: string,
): Candidate | { reason: string } {
  const posted = date(value(found, 'DTPOSTED'));
  if (posted === null) return { reason: `Unreadable date "${value(found, 'DTPOSTED')}"` };

  const parsed = parseAmount(value(found, 'TRNAMT'));
  if (parsed === null) return { reason: `Unreadable amount "${value(found, 'TRNAMT')}"` };
  const amount = parsed.value;

  const currency = readCurrency(
    value(child(found, 'CURRENCY') ?? found, 'CURSYM') || fallbackCurrency,
  );
  if (currency === null) return { reason: 'No currency for this transaction, and none stated' };

  // NAME is the payee as the bank wrote it, MEMO whatever it added. Most
  // French exports fill NAME with the whole label and leave MEMO empty.
  const name = value(found, 'NAME');
  const memo = value(found, 'MEMO');
  const description = name === '' ? memo : name;

  // Only the structured field. NAME holds "CARTE 05/01 CARREFOUR MARKET 4972"
  // as often as it holds a payee, and filing that as who was on the other side
  // would put a different counterparty on every visit to one shop. Where the
  // bank did not separate them, a categorisation rule reads it out (§8.6).
  const payee = child(found, 'PAYEE');
  const counterparty = payee === undefined ? '' : value(payee, 'NAME');

  const id = value(found, 'FITID');

  const entry: CandidateEntry = {
    account,
    amount: amount.toFixed(),
    currency,
    // Kept only when it says something the description does not. Repeated on
    // both, it is a second copy of the same sentence under every row.
    ...(memo === '' || memo === description ? {} : { memo }),
  };

  return {
    ...(id === '' ? {} : { externalId: id }),
    bookedOn: posted,
    kind: kind(value(found, 'TRNTYPE'), amount.isNegative()),
    ...(description === '' ? {} : { description }),
    ...(counterparty === '' ? {} : { counterparty }),
    sourceLines: [found.line],
    entries: [
      entry,
      { account: STATEMENT_COUNTERPART, amount: amount.negated().toFixed(), currency },
    ],
  };
}

/**
 * The transaction kind, from the type where it adds anything.
 *
 * Most of OFX's fifteen types collapse to two: ATM, POS, CHECK, PAYMENT and
 * DIRECTDEBIT are all money leaving, and the ledger has one word for that. The
 * four kept are the ones the ledger can tell apart, and the sign answers the
 * rest - which is also what a described CSV does, so a statement read either
 * way files the same way.
 */
function kind(type: string, negative: boolean): string {
  switch (type.toUpperCase()) {
    case 'INT':
      return 'interest';
    case 'DIV':
      return 'dividend';
    case 'FEE':
    case 'SRVCHG':
      return 'fee';
    case 'XFER':
      return 'transfer';
    default:
      return negative ? 'withdrawal' : 'deposit';
  }
}

/**
 * The accounting day out of an OFX timestamp.
 *
 * `YYYYMMDD`, optionally followed by a time and a zone - `20260105120000.000
 * [+1:CET]`. The first eight digits are the day the bank booked it, and the
 * time is deliberately dropped: an instant late on the 31st is the 1st in half
 * the world, which is ADR-0006's argument for a date being a date.
 */
function date(raw: string): LedgerDate | null {
  const digits = raw.trim().slice(0, 8);
  if (!/^\d{8}$/.test(digits)) return null;

  try {
    return ledgerDate(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`);
  } catch {
    // A well-formed 20260231 is caught here rather than becoming 2 March.
    return null;
  }
}

/**
 * The document, as a tree.
 *
 * One rule does both dialects: a tag holding text is a leaf and its text closes
 * it. A `</TAG>` for something already closed that way is skipped, which is
 * every closing tag in an OFX 2.x file and none in a 1.x one.
 *
 * Tolerant on purpose. This is a format real banks emit imperfectly, and a
 * parser that threw on a stray tag would refuse a file whose four hundred
 * transactions are all perfectly readable.
 */
function parse(text: string): Node {
  const root: Node = { tag: '', value: '', line: 1, children: [] };
  const stack: Node[] = [root];

  // The header block, and the XML declaration before it in 2.x. Everything
  // before the first tag is `KEY:VALUE` lines that say how the file is encoded,
  // which is a question already answered by the time this reads a string.
  let at = text.indexOf('<');
  if (at === -1) return root;
  let line = 1 + count(text.slice(0, at));

  while (at < text.length) {
    if (text[at] === '<') {
      const close = text.indexOf('>', at);
      if (close === -1) break;

      const tag = text.slice(at + 1, close).trim();
      // Where the tag opened, not where it ended: a node's line is what the
      // preview points at, and pointing past a tag that wrapped is worse than
      // not pointing at all.
      const opened = line;
      line += count(text.slice(at, close));
      at = close + 1;

      // `<?xml ...?>`, `<?OFX ...?>`, `<!-- -->`. Neither opens nor closes.
      if (tag.startsWith('?') || tag.startsWith('!')) continue;

      if (tag.startsWith('/')) {
        const name = tag.slice(1).trim().toUpperCase();
        // Popped only if it is still open. In 2.x the value already closed it.
        if (stack.some((node) => node.tag === name)) {
          while (stack.length > 1 && stack.pop()!.tag !== name);
        }
        continue;
      }

      // `<TAG/>`, which carries nothing worth keeping.
      if (tag.endsWith('/')) continue;

      const node: Node = { tag: tag.toUpperCase(), value: '', line: opened, children: [] };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      continue;
    }

    const next = text.indexOf('<', at);
    const raw = text.slice(at, next === -1 ? text.length : next);
    line += count(raw);
    at = next === -1 ? text.length : next;

    const trimmed = raw.trim();
    // Whitespace between tags is layout, not a value - and treating it as one
    // would close every container the moment it was indented.
    if (trimmed === '') continue;

    const top = stack[stack.length - 1]!;
    top.value = entities(trimmed);
    if (stack.length > 1) stack.pop();
  }

  return root;
}

function count(text: string): number {
  let lines = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return lines;
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function entities(text: string): string {
  if (!text.includes('&')) return text;

  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

function child(node: Node, tag: string): Node | undefined {
  return node.children.find((one) => one.tag === tag);
}

/** A child's text, or the empty string. Absent and empty are the same question here. */
function value(node: Node, tag: string): string {
  return child(node, tag)?.value ?? '';
}

/** Every descendant with this tag, in document order. */
function deep(node: Node, tag: string): Node[] {
  const found: Node[] = [];

  const walk = (current: Node) => {
    for (const one of current.children) {
      if (one.tag === tag) found.push(one);
      else walk(one);
    }
  };

  walk(node);
  return found;
}
