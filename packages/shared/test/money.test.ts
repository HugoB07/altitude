import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CurrencyMismatchError, Money, currency, dec } from '../src/index.js';

describe('Money — the reason ADR-0006 exists', () => {
  it('adds 0.1 and 0.2 to exactly 0.3', () => {
    const total = Money.of('0.1', 'EUR').plus(Money.of('0.2', 'EUR'));
    expect(total.amount.toFixed()).toBe('0.3');
    expect(total.equals(Money.of('0.3', 'EUR'))).toBe(true);
  });

  it('does not drift over ten thousand additions', () => {
    let total = Money.zero('EUR');
    for (let i = 0; i < 10_000; i++) {
      total = total.plus(Money.of('0.01', 'EUR'));
    }
    // A float accumulator lands on 100.00000000000186 here.
    expect(total.amount.toFixed()).toBe('100');
  });

  it('holds an eighteen-decimal crypto quantity without loss', () => {
    const wei = Money.of('0.000000000000000001', 'ETH');
    expect(wei.times('1000000000000000000').amount.toFixed()).toBe('1');
  });

  it('never emits exponential notation', () => {
    expect(Money.of('0.000000000000000001', 'BTC').toJSON().amount).toBe('0.000000000000000001');
    expect(Money.of('1000000000000000000000', 'BTC').toJSON().amount).toBe(
      '1000000000000000000000',
    );
  });
});

describe('Money — currency safety', () => {
  it('refuses to add different currencies', () => {
    const eur = Money.of('10', 'EUR');
    const usd = Money.of('10', 'USD') as unknown as Money<'EUR'>;
    expect(() => eur.plus(usd)).toThrow(CurrencyMismatchError);
  });

  it('refuses to compare across currencies', () => {
    const eur = Money.of('10', 'EUR');
    const usd = Money.of('10', 'USD') as unknown as Money<'EUR'>;
    expect(() => eur.compare(usd)).toThrow(CurrencyMismatchError);
  });

  it('treats a differing currency as unequal rather than throwing', () => {
    const eur = Money.of('10', 'EUR');
    const usd = Money.of('10', 'USD') as unknown as Money<'EUR'>;
    expect(eur.equals(usd)).toBe(false);
  });

  it('normalises the currency code to upper case', () => {
    expect(Money.of('1', currency('eur')).currency).toBe('EUR');
  });

  it('rejects a malformed currency code', () => {
    expect(() => currency('E')).toThrow(TypeError);
    expect(() => currency('12345')).toThrow(TypeError);
  });
});

describe('Money — boundaries', () => {
  it('refuses a number, at runtime as well as at compile time', () => {
    // The cast reproduces what arrives from JSON or an untyped import.
    expect(() => dec(0.1 as unknown as string)).toThrow(TypeError);
    expect(() => Money.of(1.5 as unknown as string, 'EUR')).toThrow(TypeError);
  });

  it('serialises the amount as a string', () => {
    const json = Money.of('1234.56', 'EUR').toJSON();
    expect(json).toEqual({ amount: '1234.56', currency: 'EUR' });
    expect(typeof json.amount).toBe('string');
  });

  it('is immutable', () => {
    const money = Money.of('10', 'EUR');
    money.plus(Money.of('5', 'EUR'));
    expect(money.amount.toFixed()).toBe('10');
    expect(Object.isFrozen(money)).toBe(true);
  });

  it('rounds half to even, only when asked', () => {
    expect(Money.of('2.5', 'EUR').round(0).amount.toFixed()).toBe('2');
    expect(Money.of('3.5', 'EUR').round(0).amount.toFixed()).toBe('4');
    expect(Money.of('0.125', 'EUR').round(2).amount.toFixed()).toBe('0.12');
  });
});

// ── Property-based tests ─────────────────────────────────────────────────
// Written alongside the code, not after it: they define what Money means
// rather than describing what it happens to do (plan §15.1).

const amount = fc
  .tuple(
    fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
    fc.integer({ min: 0, max: 999_999 }),
  )
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(6, '0')}`);

const eur = amount.map((value) => Money.of(value, 'EUR'));

describe('Money — properties', () => {
  it('addition is commutative', () => {
    fc.assert(
      fc.property(eur, eur, (a, b) => {
        expect(a.plus(b).equals(b.plus(a))).toBe(true);
      }),
    );
  });

  it('addition is associative — the property floats break', () => {
    fc.assert(
      fc.property(eur, eur, eur, (a, b, c) => {
        expect(
          a
            .plus(b)
            .plus(c)
            .equals(a.plus(b.plus(c))),
        ).toBe(true);
      }),
    );
  });

  it('subtraction inverts addition exactly', () => {
    fc.assert(
      fc.property(eur, eur, (a, b) => {
        expect(a.plus(b).minus(b).equals(a)).toBe(true);
      }),
    );
  });

  it('negation is its own inverse', () => {
    fc.assert(
      fc.property(eur, (a) => {
        expect(a.negated().negated().equals(a)).toBe(true);
        expect(a.plus(a.negated()).isZero()).toBe(true);
      }),
    );
  });

  it('survives a serialisation round trip unchanged', () => {
    fc.assert(
      fc.property(eur, (a) => {
        const json = a.toJSON();
        expect(Money.of(json.amount, json.currency).equals(a)).toBe(true);
      }),
    );
  });

  it('orders consistently with equality', () => {
    fc.assert(
      fc.property(eur, eur, (a, b) => {
        const cmp = a.compare(b);
        expect(cmp === 0).toBe(a.equals(b));
        expect(b.compare(a)).toBe(-cmp);
      }),
    );
  });
});
