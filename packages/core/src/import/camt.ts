import { ledgerDate, type Decimal, type LedgerDate } from '@altitude/shared';
import { readCurrency } from './currencies';
import { STATEMENT_ACCOUNT, STATEMENT_COUNTERPART } from './mapped';
import { child, deep, descend, readMarkup, value, type MarkupNode } from './markup';
import { parseAmount } from './numbers';
import type {
  BalanceReading,
  Candidate,
  CandidateEntry,
  ImportProblem,
  ImportReading,
} from './types';

/**
 * CAMT.053, the ISO 20022 bank statement.
 *
 * The plan calls it "the richest: standardised transaction codes and
 * counterparty data" and "the standard for business accounts" (§8.1). Both are
 * true, and the second is what makes it worth having beyond OFX: a French
 * business account is often the only thing a bank will export in a structured
 * format at all, and this is the format it exports.
 *
 * What it gives that nothing else does is who was on the other side, as a
 * field rather than as a sentence to be mined. Every other reader has to guess
 * a shop out of "CARTE 05/01 SUPERMARCHE INVENTE 4972" with a rule (§8.6); here
 * the bank already separated the name from the noise, and the only thing to get
 * right is which of the two parties is the other one.
 *
 * Amounts are unsigned. The direction is a separate element, `CdtDbtInd`, and
 * reading the amount without it books every debit as money arriving - which is
 * the one mistake this format invites and the reason the sign is computed in
 * one place below.
 *
 * Three schema versions are in the wild (001.02 through 001.08) and they moved
 * two things that matter: the entry status became a code inside an element, and
 * the related parties gained a `Pty` level. Both are read either way rather
 * than by branching on the namespace, because a bank is free to emit a version
 * this has never seen and the shapes are unambiguous.
 */

export function looksLikeCamt(text: string): boolean {
  const head = text.slice(0, 4096);
  // The namespace names the message and its version. The element is checked too
  // because a file stripped of its namespace is still readable, and because
  // some middleware rewrites the URN on the way out of a bank.
  return /camt\.053/i.test(head) || /<(?:[\w.-]+:)?BkToCstmrStmt[\s>]/i.test(head);
}

export function readCamt(text: string): ImportReading {
  const root = readMarkup(text);
  const statements = deep(root, 'STMT');

  if (statements.length === 0) {
    // Said as its own sentence rather than as an empty result. CAMT.052 and
    // CAMT.054 are real ISO 20022 files with a different root, and "nothing to
    // import" would send somebody looking for a problem with their bank.
    const other = camtSiblings(root);
    return {
      candidates: [],
      accounts: [],
      securities: [],
      counterparts: [],
      problems: [
        {
          line: 1,
          reason:
            other === null
              ? 'This XML file holds no CAMT.053 statement'
              : `This is a ${other} message, and only CAMT.053 statements are read`,
        },
      ],
      skipped: [],
    };
  }

  const problems: ImportProblem[] = [];
  const skipped: ImportProblem[] = [];
  const candidates: Candidate[] = [];
  const accounts: string[] = [];

  for (const statement of statements) {
    const label = accountLabel(statement);
    if (!accounts.includes(label)) accounts.push(label);

    // The account's own currency, which every entry may override through the
    // `Ccy` attribute on its amount. Both are read rather than assumed: an
    // entry with neither is one whose amount means nothing, and guessing the
    // household's currency would put dollars in a euro account without a word.
    const fallback = value(child(statement, 'ACCT') ?? statement, 'CCY');

    for (const found of deep(statement, 'NTRY')) {
      const state = status(found);
      if (state !== null) {
        // Not a problem, and kept apart from them for that reason. A pending
        // card authorisation has not moved any money, and importing it puts a
        // transaction in the ledger that the next statement will book again.
        skipped.push({
          line: found.line,
          reason:
            state === 'PDNG'
              ? 'Pending: this entry has not been booked yet'
              : `Informational only: this entry is marked "${state}"`,
        });
        continue;
      }

      const built = entry(found, label, fallback);
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
    skipped,
    ...(closing === null ? {} : { balances: closing }),
  };
}

/** The ISO 20022 message this file actually is, when it is a neighbouring one. */
function camtSiblings(root: MarkupNode): string | null {
  for (const [tag, name] of [
    ['BKTOCSTMRACCTRPT', 'CAMT.052 account report'],
    ['BKTOCSTMRDBTCDTNTFCTN', 'CAMT.054 debit or credit notification'],
    ['CSTMRCDTTRFINITN', 'PAIN.001 payment initiation'],
  ] as const) {
    if (deep(root, tag).length > 0) return name;
  }
  return null;
}

/**
 * The account this statement is about, as the file names it.
 *
 * The IBAN, which is what a person recognises, falling back to whatever other
 * identifier the bank used. It is shown so they can say which of their accounts
 * it is, and it is not written anywhere: the binding it produces is an account
 * id, and the label is gone with the request.
 */
function accountLabel(statement: MarkupNode): string {
  const id = descend(statement, 'ACCT', 'ID');
  const iban = id === undefined ? '' : value(id, 'IBAN');
  if (iban !== '') return iban;

  const other = descend(id, 'OTHR');
  const written = other === undefined ? '' : value(other, 'ID');
  return written === '' ? STATEMENT_ACCOUNT : written;
}

/**
 * Why this entry should not be imported, or null when it should.
 *
 * `BOOK` is money that moved. `PDNG` is a card authorisation that has not
 * settled and will arrive again, booked, on the next statement. `INFO` is a
 * note. An absent status is read as booked, which is what the writers that
 * omit it mean by omitting it.
 *
 * Written as an element in camt.053.001.02 and as a code inside one from .08
 * onwards. Both are read: a bank is free to emit a version this has never seen.
 */
function status(entry: MarkupNode): string | null {
  const node = child(entry, 'STS');
  if (node === undefined) return null;

  const code = (node.value || value(node, 'CD')).trim().toUpperCase();
  return code === '' || code === 'BOOK' ? null : code;
}

/**
 * The closing booked balance, when the file states one and states it once.
 *
 * `CLBD` is the balance after the last booked entry, which is the half of
 * reconciling that CAMT can support on its own: there is no running balance per
 * entry, so nothing to read back line by line, and `checked` says so honestly
 * rather than claiming a check that never ran.
 *
 * `CLAV` is deliberately not read. It is the *available* balance, which nets
 * off holds and pending card authorisations - comparing a ledger against it
 * would report a gap that is not an error and that nothing in the file explains.
 *
 * Omitted when the file holds several statements. Two closing balances on two
 * accounts are not one number, and picking either would compare the ledger
 * against half of what was imported.
 */
function balances(statements: readonly MarkupNode[]): BalanceReading | null {
  if (statements.length !== 1) return null;

  const statement = statements[0]!;
  const closing = deep(statement, 'BAL').filter((one) => balanceCode(one) === 'CLBD');
  // The last, so a statement stating one per day ends on the one that matches
  // its own end date rather than on its first morning.
  const last = closing[closing.length - 1];
  if (last === undefined) return null;

  const parsed = parseAmount(value(last, 'AMT'));
  if (parsed === null) return null;

  return {
    account: accountLabel(statement),
    // A closing balance carries a direction like any other amount: `DBIT` here
    // means the account is overdrawn, and reading it unsigned would reconcile
    // an overdraft against its own mirror image.
    closing: signed(parsed.value, value(last, 'CDTDBTIND')).toFixed(),
    checked: 0,
    mismatches: [],
  };
}

/** `Tp/CdOrPrtry/Cd`, which is where a balance says which balance it is. */
function balanceCode(balance: MarkupNode): string {
  const type = child(balance, 'TP');
  if (type === undefined) return '';
  const choice = child(type, 'CDORPRTRY') ?? type;
  return (value(choice, 'CD') || value(choice, 'PRTRY')).trim().toUpperCase();
}

function entry(
  found: MarkupNode,
  account: string,
  fallbackCurrency: string,
): Candidate | { reason: string } {
  const booked = date(found);
  if (booked === null) return { reason: 'No readable booking or value date on this entry' };

  const amount = child(found, 'AMT');
  const parsed = parseAmount(amount?.value ?? '');
  if (parsed === null) return { reason: `Unreadable amount "${amount?.value ?? ''}"` };

  const direction = value(found, 'CDTDBTIND').trim().toUpperCase();
  if (direction !== 'CRDT' && direction !== 'DBIT') {
    // The one element that says which way the money went. Without it the
    // amount is a magnitude, and booking it either way is a coin toss on
    // somebody's ledger.
    return { reason: `No direction on this entry: CdtDbtInd is "${direction}"` };
  }
  const signedAmount = signed(parsed.value, direction);

  const currency = readCurrency(amount?.attributes['CCY'] ?? fallbackCurrency);
  if (currency === null) return { reason: 'No currency for this entry, and none on the account' };

  // One entry can hold several transaction details - a batched direct debit
  // run is one booking and forty payers. The entry's own amount is still the
  // one that moved, so it stays one candidate, and the details are only read
  // for a description and a name when there is exactly one to read.
  const details = deep(found, 'TXDTLS');
  const only = details.length === 1 ? details[0]! : undefined;

  const additional = value(found, 'ADDTLNTRYINF');
  const remittance = only === undefined ? '' : unstructured(only);
  const description = remittance === '' ? additional : remittance;

  const counterparty = only === undefined ? '' : otherParty(only, direction);

  const id = reference(found);

  const candidateEntry: CandidateEntry = {
    account,
    amount: signedAmount.toFixed(),
    currency,
    // Kept only when it says something the description does not. Repeated on
    // both, it is a second copy of the same sentence under every row.
    ...(additional === '' || additional === description ? {} : { memo: additional }),
  };

  return {
    ...(id === '' ? {} : { externalId: id }),
    bookedOn: booked,
    kind: kind(found, signedAmount.isNegative()),
    ...(description === '' ? {} : { description }),
    ...(counterparty === '' ? {} : { counterparty }),
    sourceLines: [found.line],
    entries: [
      candidateEntry,
      { account: STATEMENT_COUNTERPART, amount: signedAmount.negated().toFixed(), currency },
    ],
  };
}

/**
 * Who was on the other side, which is the whole reason this format is richer.
 *
 * Money leaving means the other party is the creditor; money arriving means it
 * is the debtor. Reading one of the two unconditionally is the mistake this
 * exists to avoid: on half a statement it names the account holder, and a
 * ledger then reports every salary as having been paid to oneself.
 *
 * `Cdtr` sits directly under `RltdPties` up to camt.053.001.05 and under a
 * `Pty` choice from .08. Both are looked for.
 */
function otherParty(details: MarkupNode, direction: string): string {
  const parties = child(details, 'RLTDPTIES');
  if (parties === undefined) return '';

  const side = direction === 'DBIT' ? 'CDTR' : 'DBTR';
  const party = child(parties, side);
  if (party === undefined) return '';

  // `Cdtr/Nm` up to .05, `Cdtr/Pty/Nm` from .08.
  const nested = descend(party, 'PTY');
  const name = (nested === undefined ? '' : value(nested, 'NM')) || value(party, 'NM');
  return name.trim();
}

/** Every `RmtInf/Ustrd`, joined. A long reference is split across several. */
function unstructured(details: MarkupNode): string {
  const remittance = child(details, 'RMTINF');
  if (remittance === undefined) return '';

  return remittance.children
    .filter((one) => one.tag === 'USTRD')
    .map((one) => one.value.trim())
    .filter((one) => one !== '')
    .join(' ')
    .trim();
}

/**
 * The bank's own reference for this entry, where it is one.
 *
 * This is what makes re-importing the same file add nothing: it lands in
 * `transactions.external_id`, which is unique per household.
 *
 * `EndToEndId` is deliberately not used, tempting as it is. It is assigned by
 * whoever initiated the payment, and the overwhelmingly common value is the
 * literal `NOTPROVIDED` - which as an external id would make every entry in a
 * statement the same transaction, and deduplication would then drop all but the
 * first. The placeholders below are refused for the same reason, since banks
 * write them into the servicer reference too.
 */
const PLACEHOLDERS = new Set(['NOTPROVIDED', 'NOTPROVIDED.', 'NA', 'N/A', 'NONE', 'UNKNOWN', '0']);

function reference(found: MarkupNode): string {
  for (const tag of ['ACCTSVCRREF', 'NTRYREF']) {
    const written = value(found, tag).trim();
    if (written !== '' && !PLACEHOLDERS.has(written.toUpperCase())) return written;
  }
  return '';
}

/**
 * The accounting day: when the bank booked it, and the value date if it did not
 * say.
 *
 * `Dt` is a plain date and `DtTm` an instant, and the instant is cut to its
 * day rather than converted: a booking late on the 31st is the 1st in half the
 * world, which is ADR-0006's argument for a date being a date.
 */
function date(found: MarkupNode): LedgerDate | null {
  for (const tag of ['BOOKGDT', 'VALDT']) {
    const node = child(found, tag);
    if (node === undefined) continue;

    const written = (value(node, 'DT') || value(node, 'DTTM') || node.value).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(written)) continue;

    try {
      return ledgerDate(written);
    } catch {
      // A well-formed 2026-02-31 is caught here rather than becoming 2 March.
      continue;
    }
  }

  return null;
}

/**
 * The transaction kind, from the bank transaction code where it adds anything.
 *
 * ISO 20022 has several hundred sub-family codes and the ledger has thirteen
 * kinds, so most of the mapping would be a table translating detail into the
 * word "withdrawal". The four below are the ones the ledger can genuinely tell
 * apart; the sign answers the rest, which is what a described CSV does and what
 * the OFX reader does, so a statement read any of the three ways files the same.
 */
function kind(found: MarkupNode, negative: boolean): string {
  const code = child(found, 'BKTXCD');
  const domain = code === undefined ? undefined : child(code, 'DOMN');
  const family = domain === undefined ? undefined : child(domain, 'FMLY');
  const sub = family === undefined ? '' : value(family, 'SUBFMLYCD').trim().toUpperCase();

  switch (sub) {
    case 'INTR':
      return 'interest';
    case 'DIVD':
      return 'dividend';
    case 'FEES':
    case 'CHRG':
      return 'fee';
    case 'TAXE':
      return 'tax';
    default:
      return negative ? 'withdrawal' : 'deposit';
  }
}

/** The amount, given the direction the file stated separately. */
function signed(amount: Decimal, direction: string): Decimal {
  return direction.trim().toUpperCase() === 'DBIT' ? amount.negated() : amount;
}
