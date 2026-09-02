import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import { EXTERNAL, looksLikeTradeRepublic, readTradeRepublic, securitiesLabel } from '../src/index';
import type { Candidate } from '../src/index';

/**
 * The shape of a Trade Republic export, with invented figures.
 *
 * Modelled on a real file and holding none of its data. SECURITY.md and
 * CONTRIBUTING are explicit that real financial data never enters the
 * repository, and a fixture is exactly where it would slip in unnoticed - the
 * structure is what the tests need, and the amounts are made up.
 */
const HEADER = [
  'datetime',
  'date',
  'account_type',
  'category',
  'type',
  'asset_class',
  'name',
  'symbol',
  'shares',
  'price',
  'amount',
  'fee',
  'tax',
  'currency',
  'original_amount',
  'original_currency',
  'fx_rate',
  'description',
  'transaction_id',
  'counterparty_name',
  'counterparty_iban',
  'payment_reference',
  'mcc_code',
].join(';');

function row(fields: Partial<Record<string, string>>): string {
  const names = HEADER.split(';');
  return names.map((name) => fields[name] ?? '').join(';');
}

const TRANSFER_OUT = row({
  date: '18/05/2026',
  account_type: 'DEFAULT',
  category: 'CASH',
  type: 'TRANSFER_OUT',
  amount: '-100.000000',
  currency: 'EUR',
  description: 'Versement PEA',
  transaction_id: 'tx-out-1',
});
const TRANSFER_IN = row({
  date: '18/05/2026',
  account_type: 'PEA',
  category: 'CASH',
  type: 'TRANSFER_IN',
  amount: '100.000000',
  currency: 'EUR',
  description: 'Versement PEA',
  transaction_id: 'tx-in-1',
});
const BUY = row({
  date: '18/05/2026',
  account_type: 'PEA',
  category: 'TRADING',
  type: 'BUY',
  asset_class: 'FUND',
  name: 'Some Europe ETF',
  symbol: 'FR0000000001',
  shares: '4.0000000000',
  price: '25.0000000000',
  amount: '-100.00',
  currency: 'EUR',
  description: 'Savings plan execution',
  transaction_id: 'tx-buy-1',
});
const INTEREST = row({
  date: '01/06/2026',
  account_type: 'DEFAULT',
  category: 'CASH',
  type: 'INTEREST_PAYMENT',
  amount: '2.000000',
  tax: '-0.50',
  currency: 'EUR',
  description: 'Interest payment',
  transaction_id: 'tx-int-1',
});
const INBOUND = row({
  date: '21/05/2026',
  account_type: 'DEFAULT',
  category: 'CASH',
  type: 'TRANSFER_INSTANT_INBOUND',
  amount: '500.000000',
  currency: 'EUR',
  description: 'Incoming transfer',
  transaction_id: 'tx-in-2',
});

const file = (...rows: string[]) => [HEADER, ...rows, ''].join('\n');

/** Every candidate must balance; nothing downstream will accept one that does not. */
function residual(candidate: Candidate, currency = 'EUR'): string {
  return candidate.entries
    .filter((entry) => entry.currency === currency)
    .reduce((total, entry) => total.plus(dec(entry.amount)), dec('0'))
    .toFixed();
}

describe('looksLikeTradeRepublic', () => {
  it('recognises the export by its columns', () => {
    expect(looksLikeTradeRepublic(file(INBOUND))).toBe(true);
  });

  it('rejects another bank rather than reading it as nonsense', () => {
    expect(looksLikeTradeRepublic('date,label,amount\n01/05/2026,Rent,-800')).toBe(false);
  });
});

describe('readTradeRepublic', () => {
  it('says what is wrong with a file it cannot read, rather than returning nothing', () => {
    const reading = readTradeRepublic('a;b\n1;2');
    expect(reading.candidates).toEqual([]);
    expect(reading.problems[0]?.reason).toContain('Not a Trade Republic export');
  });

  /**
   * The reason this preset is code rather than a column mapping.
   *
   * The export splits a transfer between your own accounts across two rows, one
   * per side. Read as two transactions, each would need a counterpart invented
   * for it, and the money would appear to leave the household and re-enter it.
   */
  it('joins the two sides of a transfer into one transaction', () => {
    const reading = readTradeRepublic(file(TRANSFER_OUT, TRANSFER_IN));

    expect(reading.candidates).toHaveLength(1);
    const [transfer] = reading.candidates;
    expect(transfer?.sourceLines).toEqual([2, 3]);
    expect(transfer?.entries.map((e) => e.account)).toEqual(['DEFAULT', 'PEA']);
    expect(residual(transfer!)).toBe('0');
    // Both sides are inside the household, so no counterpart is invented.
    expect(transfer?.entries.some((e) => e.account === EXTERNAL)).toBe(false);
  });

  it('pairs only rows that match on day, currency and amount', () => {
    const elsewhere = TRANSFER_IN.replace('18/05/2026', '19/05/2026');
    const reading = readTradeRepublic(file(TRANSFER_OUT, elsewhere));
    // Two transactions rather than one, each with an external counterpart:
    // a different day is a different movement.
    expect(reading.candidates).toHaveLength(2);
    for (const candidate of reading.candidates) expect(residual(candidate)).toBe('0');
  });

  it('turns a purchase into cash out and a holding in', () => {
    const [buy] = readTradeRepublic(file(BUY)).candidates;

    expect(buy?.kind).toBe('buy');
    expect(residual(buy!)).toBe('0');

    const cash = buy?.entries.find((e) => e.instrument === undefined);
    const holding = buy?.entries.find((e) => e.instrument !== undefined);
    expect(cash?.amount).toBe('-100');
    expect(holding?.amount).toBe('100');
    expect(holding?.quantity).toBe('4.0000000000');
    expect(holding?.instrument?.isin).toBe('FR0000000001');
    expect(holding?.instrument?.kind).toBe('fund');
    // Two accounts, not one. The file says `PEA` on both sides and means the
    // cash on one and the shares on the other; booking both to the same account
    // netted every purchase to zero and left the holding nowhere - reported
    // from a real import, where shares landed in a current account.
    expect(cash?.account).toBe('PEA');
    expect(holding?.account).toBe(securitiesLabel('PEA'));

    // Value moved between two of the household's own accounts, so net worth is
    // unchanged. That was true before and stays true: it is the residual above,
    // not the fact that one account was named twice.
    expect(residual(buy!)).toBe('0');
  });

  it('asks about the securities account separately from the cash one', () => {
    const reading = readTradeRepublic(file(BUY));
    expect(reading.accounts).toEqual(['PEA']);
    expect(reading.securities).toEqual([securitiesLabel('PEA')]);
  });

  it('splits interest into gross and the tax already withheld', () => {
    const [interest] = readTradeRepublic(file(INTEREST)).candidates;

    expect(residual(interest!)).toBe('0');

    // Three lines, each named. The third is the one people ask about: the
    // account earned the gross and paid the tax, so what is left needs a
    // counterpart, and that is the net that actually arrived. Unnamed, it reads
    // as an unexplained figure - which is how it was reported.
    //
    // Tokens, not sentences. A reader that wrote "Withholding tax" put English
    // into a French ledger permanently, because the memo is persisted; the web
    // layer turns these into words in the language of whoever is reading.
    expect(interest?.entries).toHaveLength(3);
    expect(interest?.entries.map((e) => [e.account, e.amount, e.role])).toEqual([
      ['DEFAULT', '2', 'gross'],
      ['DEFAULT', '-0.5', 'withholdingTax'],
      [EXTERNAL, '-1.5', 'netCredited'],
    ]);
    expect(interest?.entries.every((e) => e.memo === undefined)).toBe(true);

    // 2.00 gross less 0.50 withheld is 1.50 actually credited, which is what
    // the account balance has to move by if it is to match the bank.
    const cash = interest!.entries.filter((e) => e.account === 'DEFAULT');
    expect(cash.reduce((sum, e) => sum.plus(dec(e.amount)), dec('0')).toFixed()).toBe('1.5');
  });

  it('gives money from outside a counterpart, because double entry needs one', () => {
    const [inbound] = readTradeRepublic(file(INBOUND)).candidates;
    expect(inbound?.kind).toBe('deposit');
    expect(residual(inbound!)).toBe('0');
    expect(inbound?.entries.find((e) => e.account === EXTERNAL)?.amount).toBe('-500');
  });

  it('lists the accounts the file mentions apart from the outside world', () => {
    const reading = readTradeRepublic(file(TRANSFER_OUT, TRANSFER_IN, BUY, INTEREST));

    // Two lists, because the preview asks about them differently. An account of
    // the file is one account for the whole import; the outside world is a
    // different answer on every transaction - a salary here, a transfer from
    // your own account at another bank there.
    expect([...reading.accounts].sort()).toEqual(['DEFAULT', 'PEA']);
    expect(reading.securities).toEqual([securitiesLabel('PEA')]);
    expect(reading.counterparts).toEqual([EXTERNAL]);
  });

  it('reports a bad row and keeps the rest', () => {
    const broken = INBOUND.replace('21/05/2026', '31/02/2026');
    const reading = readTradeRepublic(file(broken, INTEREST));

    // 31 February is well formed and not a date. Rejected rather than rolled
    // forward into March, which is what a naive Date would do with it.
    expect(reading.problems).toHaveLength(1);
    expect(reading.problems[0]?.line).toBe(2);
    // And the file is not abandoned at the first bad line.
    expect(reading.candidates).toHaveLength(1);
  });

  it('ignores an identifier that an anonymiser replaced with a constant', () => {
    // A shared value is not an identifier. Trusting it would make every row
    // look like the same transaction and collapse an import into one.
    const scrubbed = INBOUND.replace('tx-in-2', 'Anonyme');
    expect(readTradeRepublic(file(scrubbed)).candidates[0]?.externalId).toBeUndefined();
    expect(readTradeRepublic(file(INBOUND)).candidates[0]?.externalId).toBe('tx-in-2');
  });
});

describe('the shape of the file itself', () => {
  /**
   * The same rows, comma-separated and quoted, with ISO dates.
   *
   * This is the second shape the broker exports, and the reader used to assume
   * the first. A semicolon reader given this file parses each line into a
   * single field, finds none of the columns it needs, and reports "not a Trade
   * Republic export" - about a Trade Republic export.
   */
  function asQuotedCommas(text: string): string {
    return text
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) =>
        line
          .split(';')
          .map((cell) => `"${toIso(cell)}"`)
          .join(','),
      )
      .join('\n');
  }

  function toIso(cell: string): string {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cell);
    return match === null ? cell : `${match[3]!}-${match[2]!}-${match[1]!}`;
  }

  it('is recognised whether the fields are separated by semicolons or commas', () => {
    const semicolons = file(TRANSFER_OUT, TRANSFER_IN);
    expect(looksLikeTradeRepublic(semicolons)).toBe(true);
    expect(looksLikeTradeRepublic(asQuotedCommas(semicolons))).toBe(true);
  });

  it('reads the same transactions out of both', () => {
    const semicolons = file(TRANSFER_OUT, TRANSFER_IN, INTEREST, INBOUND);
    const reading = readTradeRepublic(asQuotedCommas(semicolons));

    expect(reading.problems).toEqual([]);
    expect(reading.candidates).toEqual(readTradeRepublic(semicolons).candidates);
  });

  it('reads an ISO date as the day it names, not as something else', () => {
    // The eleventh of January. Read as a European date it would be the first of
    // November - a difference no screen makes obvious.
    const reading = readTradeRepublic(
      asQuotedCommas(
        file(
          row({
            date: '11/01/2026',
            account_type: 'DEFAULT',
            type: 'TRANSFER_INSTANT_INBOUND',
            amount: '5.000000',
            currency: 'EUR',
          }),
        ),
      ),
    );
    expect(reading.candidates[0]?.bookedOn).toBe('2026-01-11');
  });

  it('a file that is not one is refused by naming what is missing', () => {
    const reading = readTradeRepublic(['date,amount', '2026-01-11,3'].join('\n'));
    expect(reading.candidates).toEqual([]);
    expect(reading.problems[0]?.reason).toContain('account_type');
  });
});

describe('who was on the other side', () => {
  /**
   * The exporter names them, and nothing read it until now.
   *
   * Worth reading because no category answers it: "groceries" mixes every
   * shop, and a name the bank gives is better evidence than any rule written
   * against a description.
   *
   * Both paths, because a transfer between two accounts of the same broker is
   * two rows read by different code - and that one dropped the name silently.
   */
  const named = (rows: readonly string[]) => readTradeRepublic([HEADER, ...rows, ''].join('\n'));

  it('reads it on a row that stands alone', () => {
    const reading = named([
      row({
        date: '20/05/2026',
        account_type: 'DEFAULT',
        category: 'CASH',
        type: 'TRANSFER_INSTANT_INBOUND',
        amount: '140.000000',
        currency: 'EUR',
        counterparty_name: 'M. LEROY',
      }),
    ]);
    expect(reading.candidates[0]?.counterparty).toBe('M. LEROY');
  });

  it('reads it on a transfer the file writes as two rows', () => {
    const reading = named([
      row({
        date: '20/05/2026',
        account_type: 'DEFAULT',
        category: 'CASH',
        type: 'TRANSFER_OUT',
        amount: '-50.000000',
        currency: 'EUR',
        counterparty_name: 'PEA',
      }),
      row({
        date: '20/05/2026',
        account_type: 'PEA',
        category: 'CASH',
        type: 'TRANSFER_IN',
        amount: '50.000000',
        currency: 'EUR',
      }),
    ]);
    expect(reading.candidates).toHaveLength(1);
    expect(reading.candidates[0]?.counterparty).toBe('PEA');
  });

  it('leaves it unset when the column is empty, rather than storing a blank', () => {
    const reading = named([
      row({
        date: '20/05/2026',
        account_type: 'DEFAULT',
        category: 'CASH',
        type: 'TRANSFER_INSTANT_INBOUND',
        amount: '140.000000',
        currency: 'EUR',
      }),
    ]);
    expect(reading.candidates[0]?.counterparty).toBeUndefined();
  });
});
