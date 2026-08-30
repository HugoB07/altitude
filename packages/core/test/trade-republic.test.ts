import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import { EXTERNAL, looksLikeTradeRepublic, readTradeRepublic } from '../src/index';
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
    // Both sides are the brokerage account: buying moves value within it rather
    // than out of it, which is why a purchase does not change net worth.
    expect(new Set(buy?.entries.map((e) => e.account))).toEqual(new Set(['PEA']));
  });

  it('splits interest into gross and the tax already withheld', () => {
    const [interest] = readTradeRepublic(file(INTEREST)).candidates;

    expect(residual(interest!)).toBe('0');
    expect(interest?.entries).toHaveLength(3);

    const cash = interest!.entries.filter((e) => e.account === 'DEFAULT');
    expect(cash.map((e) => e.amount)).toEqual(['2', '-0.5']);
    // 2.00 gross less 0.50 withheld is 1.50 actually credited, which is what
    // the account balance has to move by if it is to match the bank.
    expect(interest?.entries.find((e) => e.account === EXTERNAL)?.amount).toBe('-1.5');
  });

  it('gives money from outside a counterpart, because double entry needs one', () => {
    const [inbound] = readTradeRepublic(file(INBOUND)).candidates;
    expect(inbound?.kind).toBe('deposit');
    expect(residual(inbound!)).toBe('0');
    expect(inbound?.entries.find((e) => e.account === EXTERNAL)?.amount).toBe('-500');
  });

  it('lists every account the file mentions, for the preview to bind', () => {
    const reading = readTradeRepublic(file(TRANSFER_OUT, TRANSFER_IN, BUY, INTEREST));
    expect([...reading.accounts].sort()).toEqual(['DEFAULT', EXTERNAL, 'PEA']);
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
