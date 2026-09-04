import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  categorise,
  parseRuleSet,
  RULE_SETS,
  RULE_SET_COUNTRIES,
  RuleSetError,
  ruleSetFor,
  type CategorisationRule,
  type RuleSet,
} from '../src/index';

/**
 * The rules nobody in a household had to write.
 *
 * A rule somebody writes for themselves is wrong for one person and they fix
 * it. A rule shipped here is wrong for everybody at once, and the person it is
 * wrong for did not choose it - so the bar is higher, and most of what is below
 * is about what the set refuses to claim rather than about what it claims.
 *
 * Every label is invented, and modelled on how a French statement writes one.
 */
const SETS = join(import.meta.dirname, '..', 'src', 'categories', 'sets');

/** A shipped rule as the engine takes it, with the key standing in for a row. */
function asRules(set: RuleSet): CategorisationRule[] {
  return set.rules.map((rule) => ({
    id: `${set.country.toLowerCase()}/${rule.id}`,
    name: rule.name,
    priority: rule.priority,
    conditions: rule.conditions,
    categoryId: rule.category,
    counterparty: rule.counterparty,
    tagIds: [],
    stopOnMatch: rule.stopOnMatch,
    source: 'set',
  }));
}

const FR = asRules(RULE_SETS['fr']!);

function read(description: string, amount = '-54.90') {
  return categorise(
    { description, amount, accountId: 'account-current', accountClass: 'asset' },
    FR,
  );
}

describe('the rule set directory', () => {
  const files = readdirSync(SETS).filter((name) => name.endsWith('.json'));

  it('found some, so the checks below mean something', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('registers every file it holds', () => {
    const missing = files.filter(
      (name) => ruleSetFor(name.slice(0, -'.json'.length)) === undefined,
    );

    expect(missing, 'add these to FILES in src/categories/sets/index.ts').toEqual([]);
  });

  it('names each file after the country it declares', () => {
    for (const country of RULE_SET_COUNTRIES) {
      expect(files).toContain(`${country}.json`);
      expect(ruleSetFor(country)?.country).toBe(country.toUpperCase());
    }
  });

  it('parses every file straight off disk, not only as imported', () => {
    for (const name of files) {
      const raw: unknown = JSON.parse(readFileSync(join(SETS, name), 'utf8'));
      expect(() => parseRuleSet(raw, name)).not.toThrow();
    }
  });
});

describe('a rule set file that cannot be trusted', () => {
  const valid = {
    country: 'FR',
    rules: [
      {
        id: 'supermarche',
        name: 'Supermarché',
        priority: 100,
        when: { descriptionMatches: 'INVENTE' },
        then: { category: 'groceries' },
        stopOnMatch: true,
      },
    ],
  };

  const rejects = (change: unknown, because: string | RegExp) => {
    expect(() => parseRuleSet(change, 'test.json')).toThrow(because);
  };

  it('takes one that is right', () => {
    const set = parseRuleSet(valid, 'test.json');
    expect(set.rules[0]?.category).toBe('groceries');
    expect(set.categories).toEqual(['groceries']);
  });

  it('refuses a field nobody declared', () => {
    rejects({ ...valid, rulez: [] }, 'unknown field "rulez"');
  });

  it('refuses a rule with no condition, which would take everything', () => {
    const rule = { ...valid.rules[0]!, when: {} };
    rejects({ ...valid, rules: [rule] }, 'would match everything');
  });

  it('refuses an expression JavaScript cannot run', () => {
    // Shipped, it would be a rule that silently matched nothing, for everybody,
    // until somebody wondered why their groceries were uncategorised.
    const rule = { ...valid.rules[0]!, when: { descriptionMatches: '([unclosed' } };
    rejects({ ...valid, rules: [rule] }, 'not a valid expression');
  });

  it('refuses a category the application cannot write down', () => {
    // A key with no message behind it reaches a screen untranslated, which is
    // the one thing a bilingual application cannot do (ADR-0010).
    const rule = { ...valid.rules[0]!, then: { category: 'chaussettes' } };
    rejects({ ...valid, rules: [rule] }, 'no category called "chaussettes"');
  });

  it('refuses a rule that does nothing', () => {
    const rule = { ...valid.rules[0]!, then: {} };
    rejects({ ...valid, rules: [rule] }, 'then does nothing');
  });

  it('refuses two rules under one id', () => {
    // They write the same thing into `categorised_by_set`, and the screen would
    // then name either of them as the reason.
    rejects({ ...valid, rules: [valid.rules[0], valid.rules[0]] }, 'share the id');
  });

  it('refuses a country that is not a two-letter code', () => {
    rejects({ ...valid, country: 'France' }, 'ISO 3166-1');
  });

  it('names the file it is complaining about', () => {
    expect(() => parseRuleSet({}, 'fr.json')).toThrow(RuleSetError);
    expect(() => parseRuleSet({}, 'fr.json')).toThrow('fr.json:');
  });

  it('orders the rules itself rather than trusting the file', () => {
    // Order is the whole semantics of the engine. A file listed in the wrong
    // order would categorise differently from the same file sorted, which is
    // exactly the kind of difference nobody would go looking for.
    const late = { ...valid.rules[0]!, id: 'late', priority: 200 };
    const early = { ...valid.rules[0]!, id: 'early', priority: 10 };

    expect(parseRuleSet({ ...valid, rules: [late, early] }, 'x').rules.map((r) => r.id)).toEqual([
      'early',
      'late',
    ]);
  });
});

describe('the French set, on the labels a French statement writes', () => {
  it.each([
    ['CARTE 12/03 CARREFOUR MARKET 4972', 'groceries', 'Carrefour'],
    ['PAIEMENT CB E.LECLERC ST PAUL', 'groceries', 'E.Leclerc'],
    ['CB INTERMARCHE SUPER 1234', 'groceries', 'Intermarché'],
    ['ACHAT CB LIDL 9082', 'groceries', 'Lidl'],
    ['CARTE 03/04 SUPER U LES SABLES', 'groceries', 'Super U'],
    ['PRLV SEPA EDF CLIENTS', 'energy', 'EDF'],
    ['PRLV ENGIE SA', 'energy', 'Engie'],
    ['VIR SEPA SNCF CONNECT', 'transport', 'SNCF'],
    ['CB UBER TRIP HELP.UBER.COM', 'transport', 'Uber'],
    ['CB DELIVEROO PARIS', 'restaurants', 'Deliveroo'],
    ['PRLV NETFLIX.COM', 'subscriptions', 'Netflix'],
    ['CB AMAZON.FR MARKETPLACE', 'shopping', 'Amazon'],
    ['PRLV URSSAF IDF', 'taxes', 'Urssaf'],
    ['VIR CAF DE PARIS', 'benefits', 'CAF'],
  ])('files %s', (label, category, counterparty) => {
    const found = read(label);
    expect(found?.categoryId).toBe(category);
    expect(found?.counterparty).toBe(counterparty);
  });

  it.each([
    ['VIREMENT SALAIRE MARS', 'salary', '2450.00'],
    ['PRLV LOYER APPARTEMENT', 'housing', '-800.00'],
    ['RETRAIT DAB 12/03', 'cash', '-60.00'],
    ['AGIOS DU TRIMESTRE', 'bankFees', '-4.20'],
    ['CB PHARMACIE DE LA GARE', 'health', '-12.90'],
    ['CB RESTAURANT LE PETIT INVENTE', 'restaurants', '-38.00'],
    ['VIR LIVRET A', 'savings', '-200.00'],
  ])('falls back on the words a statement uses: %s', (label, category, amount) => {
    expect(read(label, amount)?.categoryId).toBe(category);
  });
});

describe('the names two rules would both claim', () => {
  /**
   * Every one of these was a rule waiting to be wrong. A set is ordered, and
   * the whole of its behaviour is which rule reaches a label first - so the
   * pairs below are the set's real specification.
   */
  it('separates a meal from a ride', () => {
    expect(read('CB UBER EATS PARIS')?.categoryId).toBe('restaurants');
    expect(read('CB UBER TRIP')?.categoryId).toBe('transport');
  });

  it('separates a subscription from a parcel', () => {
    expect(read('PRLV AMAZON PRIME')?.categoryId).toBe('subscriptions');
    expect(read('CB AMAZON.FR')?.categoryId).toBe('shopping');
  });

  it('separates the electricity contract from the forecourt', () => {
    expect(read('PRLV TOTALENERGIES ELEC')?.categoryId).toBe('energy');
    expect(read('CB TOTAL ACCESS A6')?.categoryId).toBe('fuel');
  });

  it('separates a holiday from the weekly shop', () => {
    expect(read('CB LECLERC VOYAGES')?.categoryId).toBe('leisure');
    expect(read('CB E.LECLERC DRIVE')?.categoryId).toBe('groceries');
  });

  it('separates a toll at Orange from a telephone bill', () => {
    // The A7 toll is at Orange, and the town would otherwise be read as the
    // operator - which is a wrong answer nobody would think to look for.
    expect(read('CB PEAGE ORANGE SUD')?.categoryId).toBe('transport');
    expect(read('PRLV ORANGE SA')?.categoryId).toBe('telecom');
  });

  it('keeps the bank that shares a supermarket name out of the weekly shop', () => {
    // Named but not categorised: it is a loan payment for one household and an
    // insurance premium for the next, and guessing either would be worse than
    // leaving it for the person to say.
    const found = read('PRLV CARREFOUR BANQUE');
    expect(found?.categoryId).toBeNull();
    expect(found?.counterparty).toBe('Carrefour Banque');
  });
});

describe('what the French set deliberately does not claim', () => {
  /**
   * The other half of a shipped set. A pattern that is too eager files somebody
   * else's statement wrongly and they have no idea where the answer came from,
   * so the tokens below are the ones that were narrowed on purpose.
   */
  it.each([
    'TOTAL DES OPERATIONS DU MOIS',
    'VIR QUAI DU CANAL SAINT MARTIN',
    'CB FREE SHIPPING ONLINE STORE',
    'CB APPLE STORE OPERA',
    'VIREMENT M. UNTEL',
  ])('leaves %s alone', (label) => {
    expect(read(label)).toBeNull();
  });
});

describe('a shipped rule under a household of its own', () => {
  const own: CategorisationRule = {
    id: 'rule-mine',
    name: 'Mes courses',
    priority: 100,
    conditions: { descriptionMatches: 'carrefour' },
    categoryId: 'cat-mine',
    counterparty: null,
    tagIds: [],
    stopOnMatch: false,
  };

  const line = {
    description: 'CARTE 12/03 CARREFOUR MARKET',
    amount: '-54.90',
    accountId: 'account-current',
    accountClass: 'asset',
  };

  it('never replaces what a household rule decided', () => {
    // The plan's ordering, and the reason the set is a layer rather than rows
    // copied in: an update that changes a shipped pattern must not quietly
    // change somebody's own answer with it.
    const found = categorise(line, [own, ...FR]);

    expect(found?.categoryId).toBe('cat-mine');
    expect(found?.ruleId).toBe('rule-mine');
    expect(found?.ruleSource).toBe('household');
  });

  it('fills what the household rule left empty', () => {
    // The household's rule says what it is; the set says who it was with.
    expect(categorise(line, [own, ...FR])?.counterparty).toBe('Carrefour');
  });

  it('decides on its own when no household rule fits', () => {
    const found = categorise(line, [{ ...own, conditions: { descriptionMatches: 'lidl' } }, ...FR]);

    expect(found?.categoryId).toBe('groceries');
    expect(found?.ruleId).toBe('fr/carrefour');
    expect(found?.ruleSource).toBe('set');
  });
});
