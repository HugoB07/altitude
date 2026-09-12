import { afterEach, describe, expect, it } from 'vitest';
import { defaultBaseCurrency } from '../src/server/config';

/**
 * The currency an instance starts a household in.
 *
 * Small enough to look like it needs no test, and it had a bug of exactly the
 * kind a test catches: the wizard wrote `'EUR'` in its own source, so the
 * variable the plan specifies for this (§14.1) existed in `.env.example`, was
 * read by nothing, and an instance run from Zurich started every household in
 * euros with no way to say otherwise.
 *
 * What is worth pinning is the third case. A variable that is set and wrong is
 * the one an operator will never notice on their own: the instance starts, the
 * wizard offers a currency, and it is not the one they configured.
 */
const VAR = 'ALTITUDE_BASE_CURRENCY';

afterEach(() => {
  delete process.env[VAR];
});

describe('defaultBaseCurrency', () => {
  it('is the euro when nothing says otherwise', () => {
    // A genuine default rather than a fallback that hides a missing value:
    // the first presets are French and the plan names EUR outright.
    expect(defaultBaseCurrency()).toBe('EUR');
  });

  it('is what the instance was configured with', () => {
    process.env[VAR] = 'CHF';
    expect(defaultBaseCurrency()).toBe('CHF');
  });

  it('takes a lowercase answer, since an env file is typed by hand', () => {
    process.env[VAR] = 'chf';
    expect(defaultBaseCurrency()).toBe('CHF');
  });

  it('treats blank as unset rather than as an empty currency', () => {
    process.env[VAR] = '   ';
    expect(defaultBaseCurrency()).toBe('EUR');
  });

  it('takes a crypto ticker, which the ledger counts as a currency', () => {
    // §11.3 treats crypto and stablecoins as currencies rather than as
    // securities, so the check here is the ledger's and no stricter. `EURO`
    // passes for the same reason - ten letters is the rule, not three.
    process.env[VAR] = 'USDT';
    expect(defaultBaseCurrency()).toBe('USDT');
  });

  it('refuses a value that is not a currency, naming the variable', () => {
    // Loudly, rather than falling back. Silently ignored, a typo is an instance
    // running on a default its operator believes they changed.
    process.env[VAR] = 'EU';

    expect(() => defaultBaseCurrency()).toThrow(VAR);
    expect(() => defaultBaseCurrency()).toThrow('three to ten letters');
  });
});
