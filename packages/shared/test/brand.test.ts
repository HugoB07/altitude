import { describe, expect, it } from 'vitest';
import {
  ZERO,
  accountId,
  categoryId,
  dec,
  householdId,
  instrumentId,
  isUuid,
  ownerId,
  portfolioId,
  transactionId,
  userId,
} from '../src/index';

const VALID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('branded ids', () => {
  it('accepts a well-formed UUID for every id kind', () => {
    for (const make of [
      accountId,
      portfolioId,
      householdId,
      ownerId,
      userId,
      instrumentId,
      transactionId,
      categoryId,
    ]) {
      expect(make(VALID)).toBe(VALID);
    }
  });

  it('names the id kind in the error, so the message points at the bug', () => {
    expect(() => accountId('nope')).toThrow(/Invalid AccountId/);
    expect(() => portfolioId('nope')).toThrow(/Invalid PortfolioId/);
    expect(() => instrumentId('nope')).toThrow(/Invalid InstrumentId/);
  });

  it('rejects anything that is not UUID-shaped', () => {
    expect(() => accountId('')).toThrow(TypeError);
    expect(() => accountId('0f8fad5b-d9cb-469f-a165')).toThrow(TypeError);
    expect(() => accountId(`${VALID}-extra`)).toThrow(TypeError);
    expect(() => accountId('0f8fad5bd9cb469fa16570867728950e')).toThrow(TypeError);
  });

  it('accepts the shapes Postgres accepts, no more and no less', () => {
    // Postgres stores any well-formed UUID, so the nil UUID and non-RFC variants
    // must pass: being stricter than the column rejects data the database keeps.
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid(VALID.toUpperCase())).toBe(true);
    expect(isUuid('g0000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('decimal helpers', () => {
  it('exposes an exact zero', () => {
    expect(ZERO.isZero()).toBe(true);
    expect(ZERO.toFixed()).toBe('0');
  });

  it('passes a Decimal through untouched', () => {
    const value = dec('1.5');
    expect(dec(value)).toBe(value);
  });

  it('names the offending value when handed a number', () => {
    expect(() => dec(0.30000000000000004 as unknown as string)).toThrow(
      /Refusing to build a Decimal from a number/,
    );
  });
});
