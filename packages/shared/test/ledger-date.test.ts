import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareDates, ledgerDate, todayIn } from '../src/index';

describe('ledgerDate — why accounting dates are not instants', () => {
  it('accepts a well-formed calendar date', () => {
    expect(ledgerDate('2026-03-01')).toBe('2026-03-01');
  });

  it('does not shift across timezones', () => {
    // The bug this type exists to prevent: new Date('2026-03-01') is midnight UTC,
    // which is 28 February anywhere west of Greenwich. A transaction booked on the
    // 1st would silently move to the previous month, taking the report with it.
    const date = ledgerDate('2026-03-01');
    expect(todayIn('Pacific/Kiritimati')).not.toBe(undefined);
    expect(date).toBe('2026-03-01');
    expect(date.slice(5, 7)).toBe('03');
  });

  it('rejects a malformed string', () => {
    expect(() => ledgerDate('01/03/2026')).toThrow(TypeError);
    expect(() => ledgerDate('2026-3-1')).toThrow(TypeError);
    expect(() => ledgerDate('2026-03-01T00:00:00Z')).toThrow(TypeError);
    expect(() => ledgerDate('')).toThrow(TypeError);
  });

  it('rejects a date that does not exist on the calendar', () => {
    expect(() => ledgerDate('2026-02-30')).toThrow(/not a real calendar date/);
    expect(() => ledgerDate('2026-13-01')).toThrow(/not a real calendar date/);
    expect(() => ledgerDate('2025-02-29')).toThrow(/not a real calendar date/);
  });

  it('accepts 29 February in a leap year', () => {
    expect(ledgerDate('2028-02-29')).toBe('2028-02-29');
  });
});

describe('compareDates', () => {
  it('orders chronologically', () => {
    expect(compareDates(ledgerDate('2026-01-01'), ledgerDate('2026-12-31'))).toBe(-1);
    expect(compareDates(ledgerDate('2026-12-31'), ledgerDate('2026-01-01'))).toBe(1);
    expect(compareDates(ledgerDate('2026-06-15'), ledgerDate('2026-06-15'))).toBe(0);
  });

  it('orders across year and month boundaries', () => {
    expect(compareDates(ledgerDate('2025-12-31'), ledgerDate('2026-01-01'))).toBe(-1);
    expect(compareDates(ledgerDate('2026-01-31'), ledgerDate('2026-02-01'))).toBe(-1);
  });

  it('is antisymmetric for any pair', () => {
    const anyDate = fc
      .date({ min: new Date('1970-01-01'), max: new Date('2099-12-31'), noInvalidDate: true })
      .map((d) => ledgerDate(d.toISOString().slice(0, 10)));

    fc.assert(
      fc.property(anyDate, anyDate, (a, b) => {
        // Summed rather than negated: -0 and +0 are distinct under Object.is,
        // so `toBe(-compareDates(b, a))` fails on every equal pair.
        expect(compareDates(a, b) + compareDates(b, a)).toBe(0);
      }),
    );
  });
});

describe('todayIn', () => {
  it('returns a valid ledger date', () => {
    expect(() => ledgerDate(todayIn())).not.toThrow();
    expect(todayIn()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('can differ by a day between timezones — which is the point', () => {
    const kiritimati = todayIn('Pacific/Kiritimati'); // UTC+14
    const midway = todayIn('Pacific/Midway'); // UTC−11
    expect(compareDates(midway, kiritimati)).toBeLessThanOrEqual(0);
  });
});
