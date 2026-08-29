import { describe, expect, it } from 'vitest';
import { Money } from '../src/index.js';

describe('Money — sign predicates', () => {
  it('treats zero as neither positive nor negative', () => {
    const zero = Money.zero('EUR');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  it('classifies a credit and a debit', () => {
    expect(Money.of('0.01', 'EUR').isPositive()).toBe(true);
    expect(Money.of('0.01', 'EUR').isNegative()).toBe(false);
    expect(Money.of('-0.01', 'EUR').isNegative()).toBe(true);
    expect(Money.of('-0.01', 'EUR').isPositive()).toBe(false);
  });

  it('handles negative zero as zero', () => {
    const negZero = Money.of('-0', 'EUR');
    expect(negZero.isZero()).toBe(true);
    expect(negZero.isNegative()).toBe(false);
    expect(negZero.isPositive()).toBe(false);
  });
});

describe('Money — arithmetic', () => {
  it('subtracts exactly', () => {
    expect(Money.of('0.3', 'EUR').minus(Money.of('0.1', 'EUR')).amount.toFixed()).toBe('0.2');
  });

  it('scales by a dimensionless factor', () => {
    // A quantity, not a Money: 10 shares at 512.30.
    expect(Money.of('512.30', 'EUR').times('10').amount.toFixed()).toBe('5123');
  });

  it('refuses a float factor', () => {
    expect(() => Money.of('10', 'EUR').times(1.5 as unknown as string)).toThrow(TypeError);
  });

  it('takes an absolute value', () => {
    expect(Money.of('-42.5', 'EUR').abs().amount.toFixed()).toBe('42.5');
    expect(Money.of('42.5', 'EUR').abs().amount.toFixed()).toBe('42.5');
  });

  it('sums a list', () => {
    const values = ['0.1', '0.2', '0.3', '-0.6'].map((v) => Money.of(v, 'EUR'));
    expect(Money.sum(values, 'EUR').isZero()).toBe(true);
  });

  it('sums an empty list to zero', () => {
    expect(Money.sum([], 'EUR').isZero()).toBe(true);
  });

  it('orders correctly', () => {
    expect(Money.of('1', 'EUR').compare(Money.of('2', 'EUR'))).toBe(-1);
    expect(Money.of('2', 'EUR').compare(Money.of('1', 'EUR'))).toBe(1);
    expect(Money.of('1', 'EUR').compare(Money.of('1.00', 'EUR'))).toBe(0);
  });
});

describe('Money — display', () => {
  it('renders amount and currency', () => {
    expect(Money.of('1234.5', 'EUR').toString()).toBe('1234.5 EUR');
    expect(Money.of('-0.01', 'USD').toString()).toBe('-0.01 USD');
  });

  it('keeps trailing precision rather than inventing cents', () => {
    // 1234.5, not 1234.50: formatting to two places is a display decision,
    // and the display layer is where it belongs (ADR-0006).
    expect(Money.of('1234.50', 'EUR').amount.toFixed()).toBe('1234.5');
  });
});
