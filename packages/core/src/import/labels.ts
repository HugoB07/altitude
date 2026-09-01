/**
 * What a bank wrote on a line, reduced to the part that identifies it.
 *
 * The eighth of the French pitfalls the plan lists (§8.3), and the one that
 * carries two others. A statement writes the same shop three different ways
 * across three months - "CARTE 12/03 CARREFOUR MARKET 4972", "CARTE 14/04
 * CARREFOUR MARKET 4972", "PAIEMENT CB CARREFOUR MARKET" - and neither
 * deduplication nor a categorisation rule can see they are the same thing
 * while the date and the card number are still in the text.
 *
 * This is not the same operation as `fold` in `mapped.ts`, which compares a
 * status cell against a word somebody typed. That one keeps everything but
 * case and accents, because "annulé" must not become "annul". Here the digits
 * are the noise.
 */

/**
 * Dates written inside a description, in the forms a French statement uses.
 *
 * ISO first: `\d{1,2}` cannot start a match inside "2026-01-15", but a reader
 * should not have to work that out, and the order costs nothing.
 */
const DATES =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/gu;

/**
 * A run of four digits or more, which is a reference, a card number or an
 * account number - never something that tells two lines apart in a way a
 * person would recognise.
 *
 * Collapsed to `#` rather than deleted, so "VIR 12345678 LOYER" and "VIR LOYER"
 * stay slightly apart, and so a description that is nothing but a reference
 * does not normalise to the empty string and silently match everything.
 */
const LONG_DIGITS = /\d{4,}/gu;

/** Anything that is not a letter, a digit or the collapse marker. */
const NOISE = /[^A-Z0-9#]+/gu;

/**
 * Uppercase, unaccented, dates and long numbers taken out, spacing collapsed.
 *
 * Returns the empty string for a description that held nothing else, which
 * callers must treat as "no evidence" rather than as a value that matches.
 */
export function normaliseLabel(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(DATES, ' ')
    .replace(LONG_DIGITS, '#')
    .replace(NOISE, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * The trigrams of a normalised label, the way `pg_trgm` cuts them.
 *
 * Each word is padded with two leading spaces and one trailing space, so a
 * short word still yields trigrams and the start of a word counts for more
 * than its middle. Matching Postgres here is deliberate: the day this moves
 * into SQL for a ledger too large to compare in memory, the threshold below
 * still means the same thing.
 */
function trigramsOf(label: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const word of label.split(' ')) {
    if (word === '') continue;
    const padded = `  ${word} `;
    for (let at = 0; at + 3 <= padded.length; at += 1) found.add(padded.slice(at, at + 3));
  }
  return found;
}

/**
 * How alike two normalised labels are, from 0 to 1.
 *
 * Jaccard over trigram sets: shared over total. Both arguments must already
 * have been through `normaliseLabel` - comparing raw descriptions would score
 * the dates and reference numbers this module exists to remove.
 */
export function trigramSimilarity(left: string, right: string): number {
  const a = trigramsOf(left);
  const b = trigramsOf(right);
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}
