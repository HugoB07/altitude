import { describe, expect, it } from 'vitest';
import { normaliseLabel, trigramSimilarity } from '../src/index';

/**
 * The last of the eight French pitfalls (plan §8.3), and the quietest.
 *
 * Nothing breaks when a description keeps its dates and its card number. The
 * file imports, the balance is right, and the damage shows up two steps later:
 * the same shop is three different strings, so deduplication cannot recognise
 * a statement re-exported a day apart, and no categorisation rule can be
 * written that survives next month.
 *
 * Every label here is invented. Real ones do not go in the repository.
 */

describe('normaliseLabel', () => {
  it('takes case and accents out, because a statement is inconsistent about both', () => {
    expect(normaliseLabel('Virement Sépa reçu')).toBe('VIREMENT SEPA RECU');
  });

  it('removes the date a card payment carries', () => {
    // The date is already a column. Left in the text it makes the same shop a
    // different string every visit.
    expect(normaliseLabel('CARTE 12/03 BOULANGERIE DU PARC')).toBe('CARTE BOULANGERIE DU PARC');
    expect(normaliseLabel('CARTE 12/03/2026 BOULANGERIE DU PARC')).toBe(
      'CARTE BOULANGERIE DU PARC',
    );
    expect(normaliseLabel('PAIEMENT 2026-03-12 BOULANGERIE DU PARC')).toBe(
      'PAIEMENT BOULANGERIE DU PARC',
    );
  });

  it('removes a time, which some exports put in the description', () => {
    expect(normaliseLabel('RETRAIT DAB 14:32 GARE CENTRALE')).toBe('RETRAIT DAB GARE CENTRALE');
  });

  it('collapses a reference number rather than deleting it', () => {
    // `#` and not nothing: "VIR 87654321 LOYER" and "VIR LOYER" are not quite
    // the same line, and a description made only of a reference must not
    // normalise to the empty string, which would match everything.
    expect(normaliseLabel('VIR 87654321 LOYER')).toBe('VIR # LOYER');
    expect(normaliseLabel('987654321')).toBe('#');
  });

  it('keeps a short number, which is usually part of a name', () => {
    expect(normaliseLabel('SNCF TGV 6521 PARIS LYON')).toBe('SNCF TGV # PARIS LYON');
    expect(normaliseLabel('GARAGE DU 15 RUE VERTE')).toBe('GARAGE DU 15 RUE VERTE');
  });

  it('turns punctuation and repeated spacing into single spaces', () => {
    expect(normaliseLabel('PRLV SEPA  EDF - CLIENTS   PARTICULIERS')).toBe(
      'PRLV SEPA EDF CLIENTS PARTICULIERS',
    );
  });

  it('brings two writings of one shop together, which is the whole point', () => {
    const march = normaliseLabel('CARTE 12/03 CARREFOUR MARKET 4972');
    const april = normaliseLabel('CARTE 14/04 CARREFOUR MARKET 4972');
    expect(march).toBe(april);
  });

  it('returns the empty string when nothing identifying is left', () => {
    // Callers have to read this as "no evidence". Treating it as a value would
    // make every unlabelled line look like every other one.
    expect(normaliseLabel('  ---  ')).toBe('');
  });
});

describe('trigramSimilarity', () => {
  it('scores a label against itself as 1', () => {
    expect(trigramSimilarity('CARREFOUR MARKET', 'CARREFOUR MARKET')).toBe(1);
  });

  it('scores two unrelated labels near 0', () => {
    expect(trigramSimilarity('CARREFOUR MARKET', 'ASSURANCE HABITATION')).toBeLessThan(0.1);
  });

  it('scores the empty string as 0 rather than as a match', () => {
    expect(trigramSimilarity('', 'CARREFOUR MARKET')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });

  it('sees through a reference one export carries and the other does not', () => {
    // The case the wider date window depends on. A bank re-exporting the same
    // month often writes the mandate reference once and not the next time,
    // which is the whole of the difference between these two lines.
    const one = normaliseLabel('PRLV SEPA ASSURANCE HABITATION 87654321');
    const two = normaliseLabel('PRLV SEPA ASSURANCE HABITATION');
    expect(trigramSimilarity(one, two)).toBeGreaterThan(0.7);
  });

  it('does not see through an abbreviation, which is a limit worth knowing', () => {
    // PRLV against PRELEVEMENT scores 0.68, just under the plan's threshold,
    // so the same direct debit written both ways three days apart is offered
    // as new rather than as a look-alike. The threshold is the plan's (§8.5)
    // and stays: loosening it to catch this would start matching lines that
    // share only their common prefix, and the shape has to match exactly
    // anyway, so what this costs is one duplicate a person can still see.
    const one = normaliseLabel('PRLV SEPA ASSURANCE HABITATION');
    const two = normaliseLabel('PRELEVEMENT SEPA ASSURANCE HABITATION');
    expect(trigramSimilarity(one, two)).toBeCloseTo(0.68, 2);
  });

  it('keeps two different shops apart even when the prefix matches', () => {
    const one = normaliseLabel('CARTE 12/03 BOULANGERIE DU PARC');
    const two = normaliseLabel('CARTE 12/03 PHARMACIE DE LA GARE');
    expect(trigramSimilarity(one, two)).toBeLessThan(0.7);
  });
});
