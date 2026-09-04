import { describe, expect, it } from 'vitest';
import { categorise, parseConditions, suggestPattern, type CategorisationRule } from '../src/index';

/**
 * The engine of plan §8.6, which is deliberately dull.
 *
 * Ordered, deterministic, and traceable to one rule. What is tested here is
 * mostly what it refuses to do: it does not guess, it does not categorise the
 * far side of a purchase, and it does not let one unusable expression take
 * down an import.
 *
 * Every label is invented.
 */

const GROCERIES = 'cat-groceries';
const RENT = 'cat-rent';

const rule = (over: Partial<CategorisationRule> = {}): CategorisationRule => ({
  id: 'rule-1',
  name: 'Groceries',
  priority: 100,
  conditions: { descriptionMatches: 'carrefour|leclerc|intermarche' },
  categoryId: GROCERIES,
  counterparty: null,
  tagIds: [],
  stopOnMatch: true,
  ...over,
});

const entry = (description: string | null, amount = '-54.90') => ({
  description,
  amount,
  accountId: 'account-current',
  accountClass: 'asset',
});

describe('categorise', () => {
  it('reads the pattern against the normalised label, not the raw one', () => {
    // The raw text carries a date and a card number that change every month.
    // A rule written in March has to still work in September.
    const found = categorise(entry('CARTE 12/03 CARREFOUR MARKET 4972'), [rule()]);
    expect(found).toEqual({
      categoryId: GROCERIES,
      ruleId: 'rule-1',
      ruleSource: 'household',
      counterparty: null,
      tagIds: [],
    });
  });

  it('ignores case and accents on both sides', () => {
    const written = rule({ conditions: { descriptionMatches: 'Intermarché' } });
    expect(categorise(entry('PAIEMENT INTERMARCHE SAINT PAUL'), [written])?.categoryId).toBe(
      GROCERIES,
    );
  });

  it('accepts the inline flag the plan itself writes', () => {
    // `(?i)` is a syntax error in JavaScript, and it is what the plan's example
    // uses and what anyone coming from another language will type.
    const written = rule({ conditions: { descriptionMatches: '(?i)carrefour' } });
    expect(categorise(entry('CARREFOUR CITY'), [written])?.categoryId).toBe(GROCERIES);
  });

  it('leaves the far side of a purchase alone', () => {
    /**
     * The mistake that would double every total.
     *
     * A purchase is two entries: the account goes down, and an equity account
     * - the edge of the household - goes up by the same amount. Categorising
     * both would count one trip to the shop as two.
     */
    const counterpart = { ...entry('CARREFOUR CITY', '54.90'), accountClass: 'equity' };
    expect(categorise(counterpart, [rule()])).toBeNull();
  });

  it('respects the bounds of an amount, signs included', () => {
    const spending = rule({ conditions: { amountBetween: ['-500', '0'] } });
    expect(categorise(entry('CARREFOUR', '-54.90'), [spending])?.categoryId).toBe(GROCERIES);
    // Money coming in is not spending, whatever the description says.
    expect(categorise(entry('CARREFOUR', '54.90'), [spending])).toBeNull();
    expect(categorise(entry('CARREFOUR', '-900'), [spending])).toBeNull();
  });

  it('requires every stated condition, not any of them', () => {
    const narrow = rule({
      conditions: { descriptionMatches: 'carrefour', amountBetween: ['-500', '0'] },
    });
    expect(categorise(entry('LECLERC', '-20'), [narrow])).toBeNull();
    expect(categorise(entry('CARREFOUR', '-20'), [narrow])?.categoryId).toBe(GROCERIES);
  });

  it('stops at the first match when the rule says to', () => {
    const first = rule({ id: 'a', priority: 10 });
    const second = rule({ id: 'b', priority: 20, categoryId: RENT });
    expect(categorise(entry('CARREFOUR'), [first, second])?.ruleId).toBe('a');
  });

  it('lets a later rule take over when an earlier one does not stop', () => {
    // How a broad rule and a narrow one live together: everything from this
    // shop is groceries, except the one line that is actually rent.
    const broad = rule({ id: 'a', priority: 10, stopOnMatch: false });
    const narrow = rule({
      id: 'b',
      priority: 20,
      conditions: { descriptionMatches: 'carrefour.*loyer' },
      categoryId: RENT,
    });
    expect(categorise(entry('CARREFOUR LOYER'), [broad, narrow])).toMatchObject({
      categoryId: RENT,
      ruleId: 'b',
      ruleSource: 'household',
    });
  });

  it('says nothing rather than guessing when no rule fits', () => {
    expect(categorise(entry('PHARMACIE DE LA GARE'), [rule()])).toBeNull();
  });

  it('matches nothing on a line with no description', () => {
    expect(categorise(entry(null), [rule()])).toBeNull();
  });
});

describe('parseConditions', () => {
  it('takes the three conditions it knows', () => {
    expect(
      parseConditions({
        descriptionMatches: 'carrefour',
        amountBetween: ['-500', '0'],
        accountId: 'account-current',
      }),
    ).toEqual({
      descriptionMatches: 'carrefour',
      amountBetween: ['-500', '0'],
      accountId: 'account-current',
    });
  });

  it('refuses an expression that cannot be compiled', () => {
    // Stored, this would throw once per entry of every import from then on.
    expect(parseConditions({ descriptionMatches: '([unclosed' })).toBeNull();
  });

  it('refuses an expression long enough to be slow', () => {
    expect(parseConditions({ descriptionMatches: 'a'.repeat(201) })).toBeNull();
  });

  it('refuses bounds that are not numbers, or that are the wrong way round', () => {
    expect(parseConditions({ amountBetween: ['abc', '0'] })).toBeNull();
    expect(parseConditions({ amountBetween: ['0', '-500'] })).toBeNull();
    expect(parseConditions({ amountBetween: ['-500'] })).toBeNull();
  });

  it('refuses a rule with no condition at all', () => {
    // It would take every entry it was offered, which nobody means to write.
    expect(parseConditions({})).toBeNull();
    expect(parseConditions(null)).toBeNull();
    expect(parseConditions([])).toBeNull();
  });
});

describe('suggestPattern', () => {
  /**
   * What the plan calls explicit learning (§8.6): recategorising a transaction
   * offers a rule for all similar descriptions. Offering the whole label would
   * write a rule matching exactly one line, which teaches nothing.
   */
  it('keeps what identifies the shop and drops what the bank says every time', () => {
    expect(suggestPattern('CARTE 12/03 CARREFOUR MARKET 4972')).toBe('CARREFOUR MARKET');
    expect(suggestPattern('PRLV SEPA ASSURANCE HABITATION 87654321')).toBe('ASSURANCE HABITATION');
    expect(suggestPattern('VIREMENT DE M. BOYAT')).toBe('M BOYAT');
  });

  it('gives back nothing when there is nothing but boilerplate', () => {
    // Better an empty field somebody fills than a rule that matches every line.
    expect(suggestPattern('CARTE 12/03 4972')).toBe('');
  });
});

describe('the three effects a rule can have', () => {
  /**
   * They accumulate differently, and that is the whole distinction between
   * them. A category is exclusive - one per entry, so categories sum to the
   * total - and a counterparty is a single name, so a later rule replaces an
   * earlier one. Tags are a set and add up: a rule that tags everything abroad
   * and a rule that tags every restaurant both apply to dinner in Madrid.
   */
  it('takes the last category and the last counterparty, and every tag', () => {
    const abroad = rule({
      id: 'a',
      conditions: { descriptionMatches: 'madrid' },
      categoryId: null,
      tagIds: ['tag-spain'],
      stopOnMatch: false,
    });
    const dining = rule({
      id: 'b',
      conditions: { descriptionMatches: 'restaurante' },
      categoryId: GROCERIES,
      counterparty: 'Casa Paco',
      tagIds: ['tag-eating-out'],
      stopOnMatch: false,
    });
    const later = rule({
      id: 'c',
      conditions: { descriptionMatches: 'restaurante' },
      categoryId: RENT,
      counterparty: 'Casa Paco SL',
      tagIds: ['tag-spain'],
    });

    expect(categorise(entry('RESTAURANTE MADRID'), [abroad, dining, later])).toEqual({
      categoryId: RENT,
      ruleId: 'c',
      ruleSource: 'household',
      counterparty: 'Casa Paco SL',
      tagIds: ['tag-spain', 'tag-eating-out'],
    });
  });

  it('matches with no category at all, for a rule that only tags', () => {
    // Which is why the column stopped being mandatory: a rule that marks every
    // line of a trip is a rule, and it decides no category.
    const marking = rule({ categoryId: null, tagIds: ['tag-spain'] });
    expect(categorise(entry('CARREFOUR CITY'), [marking])).toEqual({
      categoryId: null,
      ruleId: null,
      ruleSource: null,
      counterparty: null,
      tagIds: ['tag-spain'],
    });
  });
});
