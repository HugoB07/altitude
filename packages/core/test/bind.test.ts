import { describe, expect, it } from 'vitest';
import { accountId, ledgerDate } from '@altitude/shared';
import { bindAccounts, type Candidate } from '../src/index';

/**
 * Turning a file's vocabulary into accounts, with no database in sight.
 *
 * `bindAccounts` is pure, and its only tests lived in the suite that boots
 * PostgreSQL - so the unit run reported it at zero per cent while it was in
 * fact well covered. Ids here are invented rather than created, which is the
 * whole point: nothing about replacing a label with an id needs a connection.
 */

const CASH = accountId('11111111-0000-4000-8000-000000000001');
const SAVINGS = accountId('11111111-0000-4000-8000-000000000002');
const OPENING = accountId('11111111-0000-4000-8000-000000000003');

function candidate(amount: string, from = 'CASH', to = 'OPENING'): Candidate {
  return {
    bookedOn: ledgerDate('2026-04-01'),
    kind: 'deposit',
    sourceLines: [2],
    entries: [
      { account: from, amount, currency: 'EUR' },
      { account: to, amount: `-${amount}`, currency: 'EUR' },
    ],
  };
}

describe('bindAccounts', () => {
  const binding = { CASH, OPENING, SAVINGS };

  it('replaces every label with the account chosen for it', () => {
    const { bound, problems } = bindAccounts([candidate('10')], binding);

    expect(problems).toEqual([]);
    expect(bound[0]?.entries.map((e) => e.accountId)).toEqual([CASH, OPENING]);
    // The label survives, because the preview shows what the file called it.
    expect(bound[0]?.entries[0]?.label).toBe('CASH');
  });

  it('carries the rest of an entry through untouched', () => {
    const trade: Candidate = {
      bookedOn: ledgerDate('2026-04-01'),
      kind: 'buy',
      sourceLines: [2],
      entries: [
        { account: 'CASH', amount: '-100', currency: 'EUR' },
        {
          account: 'SAVINGS',
          amount: '100',
          currency: 'EUR',
          quantity: '4',
          unitPrice: '25',
          memo: 'Gross',
          instrument: { name: 'A fund', currency: 'EUR', kind: 'fund' },
        },
      ],
    };

    const [held] = bindAccounts([trade], binding).bound[0]!.entries.slice(1);
    expect(held?.quantity).toBe('4');
    expect(held?.unitPrice).toBe('25');
    expect(held?.memo).toBe('Gross');
    expect(held?.instrument?.name).toBe('A fund');
  });

  it('sets aside a candidate with an unbound label rather than guessing', () => {
    const { bound, problems } = bindAccounts([candidate('10')], { CASH });

    // Guessing puts money in an account nobody chose; dropping loses a
    // transaction without saying so, which is found months later if at all.
    expect(bound).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain('OPENING');
    expect(problems[0]?.line).toBe(2);
  });

  it('names each missing label once, however many entries use it', () => {
    const twice = candidate('10', 'NOWHERE', 'NOWHERE');
    const { problems } = bindAccounts([twice], binding);
    expect(problems[0]?.reason).toBe('No account chosen for NOWHERE');
  });

  it('lets one transaction answer differently from the rest of the file', () => {
    const salary = candidate('2000');
    const fromElsewhere = candidate('500');

    const { bound } = bindAccounts([salary, fromElsewhere], binding, { 1: { OPENING: SAVINGS } });

    expect(bound[0]?.entries.map((e) => e.accountId)).toEqual([CASH, OPENING]);
    expect(bound[1]?.entries.map((e) => e.accountId)).toEqual([CASH, SAVINGS]);
  });

  it('an override for a label the candidate does not mention changes nothing', () => {
    const { bound, problems } = bindAccounts([candidate('10')], binding, {
      0: { NOWHERE: SAVINGS },
    });
    expect(problems).toEqual([]);
    expect(bound[0]?.entries.map((e) => e.accountId)).toEqual([CASH, OPENING]);
  });

  it('binds nothing when given nothing', () => {
    expect(bindAccounts([], binding)).toEqual({ bound: [], problems: [] });
  });
});
