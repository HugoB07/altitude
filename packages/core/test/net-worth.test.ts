import { describe, expect, it } from 'vitest';
import { Money, accountId, ledgerDate, transactionId, type AccountId } from '@altitude/shared';
import { createTransaction, type Transaction } from '../src/index.js';

/**
 * The verification the development plan sets for the end of week 1 (§18, day 5):
 *
 *   "Record a EUR 1,000 deposit and a EUR 300 transfer to a second account, and
 *    see a net worth of EUR 1,000 — not EUR 1,300. If that number is right, the
 *    model is sound and everything else is assembly."
 *
 * This is the single claim the whole product rests on, so it is a test rather
 * than a note. A flat transactions table passes the deposit and fails the
 * transfer, which is exactly why ADR-0002 exists.
 */

const CURRENT = accountId('1b4e28ba-2fa1-4d3b-a3f5-cc4e1b7d5f21');
const SAVINGS = accountId('2c5f39cb-3fb2-4e4c-b4a6-dd5f2c8e6a32');
/** Where money entering the household comes from. Not an asset, so not counted. */
const INCOME = accountId('3d6a4adc-4ac3-4f5d-c5b7-ee6a3d9f7b43');

const ASSET_ACCOUNTS: readonly AccountId[] = [CURRENT, SAVINGS];

/**
 * Net worth as the sum of asset accounts, in one currency.
 *
 * The real engine reads `daily_balances` and converts currencies (plan §6.1);
 * this is the same arithmetic without the cache, which is what makes it a
 * useful check on the ledger rather than on the cache.
 */
function netWorth(transactions: readonly Transaction[]): Money<'EUR'> {
  return transactions
    .flatMap((t) => t.entries)
    .filter((e) => ASSET_ACCOUNTS.includes(e.accountId))
    .reduce((total, e) => total.plus(e.amount as Money<'EUR'>), Money.zero('EUR'));
}

function balanceOf(transactions: readonly Transaction[], account: AccountId): Money<'EUR'> {
  return transactions
    .flatMap((t) => t.entries)
    .filter((e) => e.accountId === account)
    .reduce((total, e) => total.plus(e.amount as Money<'EUR'>), Money.zero('EUR'));
}

describe('net worth — the week 1 verification', () => {
  const deposit = createTransaction({
    id: transactionId('0f8fad5b-d9cb-469f-a165-70867728950e'),
    bookedOn: ledgerDate('2026-03-01'),
    kind: 'deposit',
    description: 'Salary',
    entries: [
      { accountId: CURRENT, amount: Money.of('1000', 'EUR') },
      { accountId: INCOME, amount: Money.of('-1000', 'EUR') },
    ],
  });

  const transfer = createTransaction({
    id: transactionId('7c9e6679-7425-40de-944b-e07fc1f90ae7'),
    bookedOn: ledgerDate('2026-03-02'),
    kind: 'transfer',
    description: 'Move to savings',
    entries: [
      { accountId: CURRENT, amount: Money.of('-300', 'EUR') },
      { accountId: SAVINGS, amount: Money.of('300', 'EUR') },
    ],
  });

  it('counts the deposit once', () => {
    expect(netWorth([deposit]).amount.toFixed()).toBe('1000');
  });

  it('is unchanged by an internal transfer — 1000, not 1300', () => {
    expect(netWorth([deposit, transfer]).amount.toFixed()).toBe('1000');
  });

  it('still moves the money between the two accounts', () => {
    expect(balanceOf([deposit, transfer], CURRENT).amount.toFixed()).toBe('700');
    expect(balanceOf([deposit, transfer], SAVINGS).amount.toFixed()).toBe('300');
  });

  it('is unchanged by any number of transfers', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      createTransaction({
        id: transactionId(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
        bookedOn: ledgerDate('2026-03-03'),
        kind: 'transfer',
        entries: [
          { accountId: CURRENT, amount: Money.of('-0.01', 'EUR') },
          { accountId: SAVINGS, amount: Money.of('0.01', 'EUR') },
        ],
      }),
    );
    // Fifty round trips of one cent: a float accumulator drifts here, and the
    // ledger does not.
    expect(netWorth([deposit, ...many]).amount.toFixed()).toBe('1000');
  });

  it('returns to its starting point when a transaction is reversed out', () => {
    const before = netWorth([deposit]);
    const after = netWorth([deposit, transfer]);
    expect(after.equals(before)).toBe(true);
  });
});
