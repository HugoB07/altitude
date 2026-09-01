/**
 * The one place a Decimal becomes a number, for display only (ADR-0006).
 *
 * Shared rather than written per screen: two copies of this would eventually
 * disagree about the fraction digits, and a balance that reads differently on
 * two pages is a balance nobody trusts on either.
 */
export function money(amount: string, currency: string, locale: string, signed = false): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
    maximumFractionDigits: 2,
  }).format(Number(amount));
}
