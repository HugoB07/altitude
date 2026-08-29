import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  Money,
  accountId,
  dec,
  instrumentId,
  ledgerDate,
  transactionId,
  type AccountId,
} from '@altitude/shared';
import {
  InconsistentHoldingError,
  InsufficientEntriesError,
  InvalidDateRangeError,
  UnbalancedTransactionError,
  createTransaction,
  reverseTransaction,
} from '../src/index';
import type { EntryInput } from '../src/index';

const TX = transactionId('0f8fad5b-d9cb-469f-a165-70867728950e');
const TX2 = transactionId('7c9e6679-7425-40de-944b-e07fc1f90ae7');
const CURRENT = accountId('1b4e28ba-2fa1-4d3b-a3f5-cc4e1b7d5f21');
const BROKERAGE = accountId('2c5f39cb-3fb2-4e4c-b4a6-dd5f2c8e6a32');
const SALARY = accountId('3d6a4adc-4ac3-4f5d-c5b7-ee6a3d9f7b43');
const ETF = instrumentId('4e7b5bed-5bd4-405e-a6c8-ff7b4eaa8c54');

const on = ledgerDate('2026-03-01');

function tx(entries: readonly EntryInput[], overrides: Record<string, unknown> = {}) {
  return createTransaction({ id: TX, bookedOn: on, kind: 'transfer', entries, ...overrides });
}

describe('createTransaction - the balance invariant', () => {
  it('accepts a balanced two-sided transfer', () => {
    const result = tx([
      { accountId: CURRENT, amount: Money.of('-300', 'EUR') },
      { accountId: BROKERAGE, amount: Money.of('300', 'EUR') },
    ]);
    expect(result.entries).toHaveLength(2);
    expect(result.currencies).toEqual(['EUR']);
  });

  it('rejects a transaction that does not sum to zero', () => {
    expect(() =>
      tx([
        { accountId: CURRENT, amount: Money.of('-300', 'EUR') },
        { accountId: BROKERAGE, amount: Money.of('299.99', 'EUR') },
      ]),
    ).toThrow(UnbalancedTransactionError);
  });

  it('reports the exact residual, not an approximation', () => {
    try {
      tx([
        { accountId: CURRENT, amount: Money.of('-300', 'EUR') },
        { accountId: BROKERAGE, amount: Money.of('299.99', 'EUR') },
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnbalancedTransactionError);
      expect((error as UnbalancedTransactionError).residuals.get('EUR')).toBe('-0.01');
    }
  });

  it('requires at least two entries', () => {
    expect(() => tx([{ accountId: CURRENT, amount: Money.of('0', 'EUR') }])).toThrow(
      InsufficientEntriesError,
    );
  });

  it('balances each currency separately', () => {
    // +100 EUR against -100 USD is not balanced: it is two open halves.
    expect(() =>
      tx([
        { accountId: CURRENT, amount: Money.of('100', 'EUR') },
        { accountId: BROKERAGE, amount: Money.of('-100', 'USD') },
      ]),
    ).toThrow(UnbalancedTransactionError);
  });

  it('accepts a transaction balanced in two currencies at once', () => {
    const result = tx([
      { accountId: CURRENT, amount: Money.of('-100', 'EUR') },
      { accountId: BROKERAGE, amount: Money.of('100', 'EUR') },
      { accountId: BROKERAGE, amount: Money.of('118', 'USD') },
      { accountId: SALARY, amount: Money.of('-118', 'USD') },
    ]);
    expect(result.currencies).toEqual(['EUR', 'USD']);
  });
});

describe('createTransaction - the four cases a flat model breaks on', () => {
  it('1. an internal transfer nets to zero across the household', () => {
    const result = tx([
      { accountId: CURRENT, amount: Money.of('-300', 'EUR') },
      { accountId: BROKERAGE, amount: Money.of('300', 'EUR') },
    ]);
    const net = result.entries.reduce(
      (acc, e) => acc.plus(e.amount as Money<'EUR'>),
      Money.zero('EUR'),
    );
    expect(net.isZero()).toBe(true);
  });

  it('2. a share purchase moves cash and quantity in one transaction', () => {
    const result = tx(
      [
        { accountId: BROKERAGE, amount: Money.of('-5124.95', 'EUR') },
        {
          accountId: BROKERAGE,
          amount: Money.of('5123', 'EUR'),
          instrumentId: ETF,
          quantity: dec('10'),
          unitPrice: Money.of('512.30', 'EUR'),
        },
        { accountId: SALARY, amount: Money.of('1.95', 'EUR') },
      ],
      { kind: 'buy' },
    );
    const holding = result.entries.find((e) => e.instrumentId !== undefined);
    expect(holding?.quantity?.toFixed()).toBe('10');
  });

  it('3. a foreign dividend keeps gross, tax and net as separate facts', () => {
    const result = tx(
      [
        { accountId: SALARY, amount: Money.of('-120', 'USD'), memo: 'gross' },
        { accountId: BROKERAGE, amount: Money.of('18', 'USD'), memo: 'withholding tax' },
        { accountId: BROKERAGE, amount: Money.of('102', 'USD'), memo: 'net credited' },
      ],
      { kind: 'dividend' },
    );
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.memo)).toContain('withholding tax');
  });

  it('4. a loan instalment splits principal from interest', () => {
    const result = tx(
      [
        { accountId: CURRENT, amount: Money.of('-780', 'EUR') },
        { accountId: BROKERAGE, amount: Money.of('620', 'EUR'), memo: 'principal' },
        { accountId: SALARY, amount: Money.of('160', 'EUR'), memo: 'interest' },
      ],
      { kind: 'adjustment' },
    );
    expect(result.entries).toHaveLength(3);
  });
});

describe('createTransaction - holding consistency', () => {
  it('rejects a quantity without an instrument', () => {
    expect(() =>
      tx([
        { accountId: BROKERAGE, amount: Money.of('-100', 'EUR'), quantity: dec('1') },
        { accountId: CURRENT, amount: Money.of('100', 'EUR') },
      ]),
    ).toThrow(InconsistentHoldingError);
  });

  it('rejects an instrument without a quantity', () => {
    expect(() =>
      tx([
        { accountId: BROKERAGE, amount: Money.of('-100', 'EUR'), instrumentId: ETF },
        { accountId: CURRENT, amount: Money.of('100', 'EUR') },
      ]),
    ).toThrow(InconsistentHoldingError);
  });

  it('rejects a unit price without a quantity', () => {
    expect(() =>
      tx([
        { accountId: BROKERAGE, amount: Money.of('-100', 'EUR'), unitPrice: Money.of('1', 'EUR') },
        { accountId: CURRENT, amount: Money.of('100', 'EUR') },
      ]),
    ).toThrow(InconsistentHoldingError);
  });
});

describe('createTransaction - dates', () => {
  it('defaults the value date to the booking date', () => {
    const result = tx([
      { accountId: CURRENT, amount: Money.of('-1', 'EUR') },
      { accountId: BROKERAGE, amount: Money.of('1', 'EUR') },
    ]);
    expect(result.valueOn).toBe(on);
  });

  it('rejects a value date before the booking date', () => {
    expect(() =>
      tx(
        [
          { accountId: CURRENT, amount: Money.of('-1', 'EUR') },
          { accountId: BROKERAGE, amount: Money.of('1', 'EUR') },
        ],
        { valueOn: ledgerDate('2026-02-28') },
      ),
    ).toThrow(InvalidDateRangeError);
  });
});

describe('reverseTransaction', () => {
  it('produces a balanced mirror image', () => {
    const original = tx([
      { accountId: CURRENT, amount: Money.of('-300', 'EUR') },
      { accountId: BROKERAGE, amount: Money.of('300', 'EUR') },
    ]);
    const reversal = reverseTransaction(original, TX2, ledgerDate('2026-03-05'));

    expect(reversal.reversesId).toBe(original.id);
    expect(reversal.entries[0]?.amount.amount.toFixed()).toBe('300');
    expect(reversal.entries[1]?.amount.amount.toFixed()).toBe('-300');
  });

  it('negates quantities as well as amounts', () => {
    const original = tx(
      [
        { accountId: BROKERAGE, amount: Money.of('-5123', 'EUR') },
        {
          accountId: BROKERAGE,
          amount: Money.of('5123', 'EUR'),
          instrumentId: ETF,
          quantity: dec('10'),
        },
      ],
      { kind: 'buy' },
    );
    const reversal = reverseTransaction(original, TX2, on);
    const holding = reversal.entries.find((e) => e.instrumentId !== undefined);
    expect(holding?.quantity?.toFixed()).toBe('-10');
  });

  it('leaves the original untouched - the ledger is append-only', () => {
    const original = tx([
      { accountId: CURRENT, amount: Money.of('-300', 'EUR') },
      { accountId: BROKERAGE, amount: Money.of('300', 'EUR') },
    ]);
    reverseTransaction(original, TX2, on);
    expect(original.entries[0]?.amount.amount.toFixed()).toBe('-300');
  });
});

// -- Property-based tests -------------------------------------------------

const accounts: readonly AccountId[] = [CURRENT, BROKERAGE, SALARY];

const amountString = fc
  .tuple(fc.integer({ min: -100_000, max: 100_000 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => `${whole}.${String(cents).padStart(2, '0')}`);

/** Generates n−1 free amounts plus a closing line that makes the total zero. */
const balancedEntries = fc
  .array(fc.tuple(fc.constantFrom(...accounts), amountString), { minLength: 1, maxLength: 8 })
  .map((rows) => {
    const entries: EntryInput[] = rows.map(([account, value]) => ({
      accountId: account,
      amount: Money.of(value, 'EUR'),
    }));
    const total = entries.reduce((acc, e) => acc.plus(e.amount as Money<'EUR'>), Money.zero('EUR'));
    entries.push({ accountId: SALARY, amount: total.negated() });
    return entries;
  });

describe('createTransaction - properties', () => {
  it('accepts any set of entries that sums to zero', () => {
    fc.assert(
      fc.property(balancedEntries, (entries) => {
        expect(() => tx(entries)).not.toThrow();
      }),
    );
  });

  it('rejects any non-zero perturbation of a balanced set', () => {
    fc.assert(
      fc.property(
        balancedEntries,
        amountString.filter((v) => !Money.of(v, 'EUR').isZero()),
        (entries, delta) => {
          const first = entries[0];
          if (first === undefined) return;
          const broken = [
            { ...first, amount: first.amount.plus(Money.of(delta, 'EUR')) },
            ...entries.slice(1),
          ];
          expect(() => tx(broken)).toThrow(UnbalancedTransactionError);
        },
      ),
    );
  });

  it('reversing twice restores the original amounts', () => {
    fc.assert(
      fc.property(balancedEntries, (entries) => {
        const original = tx(entries);
        const once = reverseTransaction(original, TX2, on);
        const twice = reverseTransaction(once, TX, on);
        original.entries.forEach((entry, i) => {
          expect(twice.entries[i]?.amount.equals(entry.amount)).toBe(true);
        });
      }),
    );
  });

  it('entry order never changes the outcome', () => {
    fc.assert(
      fc.property(balancedEntries, (entries) => {
        expect(() => tx([...entries].reverse())).not.toThrow();
      }),
    );
  });
});
