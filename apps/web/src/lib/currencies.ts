/**
 * The currencies a person can pick, in one place.
 *
 * Shared because two screens offer them and they must agree: a household is set
 * up in one of these, and an account is opened in one of these. A list that
 * drifted between the two would let somebody open an account in a currency the
 * household could never total.
 *
 * Short on purpose. Every code here is one somebody could reasonably hold, and
 * a longer list is a longer list to scroll rather than a more useful one. The
 * domain accepts any ISO 4217 code (`currency()` in `@altitude/shared`), so
 * adding one is adding a line.
 */
export const CURRENCIES = [
  { code: 'EUR', label: 'EUR - euro' },
  { code: 'USD', label: 'USD - US dollar' },
  { code: 'GBP', label: 'GBP - pound sterling' },
  { code: 'CHF', label: 'CHF - Swiss franc' },
] as const;

export function currencyLabel(code: string): string {
  return CURRENCIES.find((currency) => currency.code === code)?.label ?? code;
}
