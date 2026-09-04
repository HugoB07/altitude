import type { RuleConditions } from '../rules';

/**
 * Rules nobody in a household had to write.
 *
 * The plan asks for "user rules first, then a community rule set per country,
 * versioned in the repository" (§8.6). What it buys is the first import: until
 * now a fresh install had no rules at all, so it categorised nothing, and every
 * person who installed Altitude wrote CARREFOUR, then LECLERC, then
 * INTERMARCHE for themselves, separately, forever.
 *
 * Files rather than rows, and that decides everything else. Copied into each
 * household at setup the set would be frozen there: a rule found to be wrong
 * would stay wrong in every database that had already taken it, and no
 * migration can safely edit somebody's categorisations after the fact. Read
 * from the files on every pass, a correction reaches everyone at the next
 * update, and a household that disagrees writes its own rule over it.
 *
 * A shipped rule can never be edited, only covered. That is the trade, and it
 * is why the set runs second: what a person wrote about their own statements
 * wins, always, and the set only fills what they left empty.
 */

/**
 * The categories a set may name.
 *
 * Closed, and deliberately. A key is not a name: the name is written in the
 * reader's language by the web layer, so a French household and an English one
 * see the same category called two things and a rule written once points at
 * both. An open list would mean a category arriving on screen untranslated,
 * which is the one thing a bilingual application cannot do (ADR-0010).
 *
 * Adding one is a line here and a line in each message catalogue. That is the
 * right price: a category is part of the application's vocabulary.
 */
export const CATEGORY_KEYS = [
  'groceries',
  'restaurants',
  'transport',
  'fuel',
  'energy',
  'housing',
  'telecom',
  'health',
  'insurance',
  'taxes',
  'salary',
  'benefits',
  'savings',
  'leisure',
  'shopping',
  'subscriptions',
  'bankFees',
  'cash',
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export interface SetRule {
  /**
   * Unique within the set, and stored on every entry it decides.
   *
   * Kebab-case and stable: `entries.categorised_by_set` holds `fr/supermarches`
   * months later, and the screen reads it back to answer "why is this in
   * groceries". Renaming one is a data migration, not a rename.
   */
  readonly id: string;
  /** What the rule is called on screen, in the set's own language. */
  readonly name: string;
  /** Lower runs first, exactly as for a household's own rules. */
  readonly priority: number;
  readonly conditions: RuleConditions;
  /** A key from `CATEGORY_KEYS`, or null for a rule that only names a shop. */
  readonly category: CategoryKey | null;
  /** The shop, the employer, the landlord - cleaned up from whatever the bank wrote. */
  readonly counterparty: string | null;
  readonly stopOnMatch: boolean;
}

export interface RuleSet {
  /** ISO 3166-1 alpha-2, and the name of the file. */
  readonly country: string;
  /** Which categories its rules point at, so a household can be offered exactly those. */
  readonly categories: readonly CategoryKey[];
  readonly rules: readonly SetRule[];
}

export class RuleSetError extends Error {
  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = 'RuleSetError';
  }
}

const KEYS = new Set(['$comment', 'country', 'rules']);
const RULE_KEYS = new Set(['$comment', 'id', 'name', 'priority', 'when', 'then', 'stopOnMatch']);
const WHEN_KEYS = new Set(['descriptionMatches', 'amountBetween']);
const THEN_KEYS = new Set(['category', 'counterparty']);

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COUNTRY = /^[A-Z]{2}$/;

/**
 * A rule set file, checked before anything trusts it.
 *
 * Stricter than the household's own rules are, because the blast radius is
 * different: a rule somebody writes for themselves is wrong for one person and
 * they fix it, and a rule shipped here is wrong for everybody at once. Unknown
 * fields are refused, every pattern is compiled, and every category named has
 * to be one the application knows how to write down.
 */
export function parseRuleSet(value: unknown, where: string): RuleSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuleSetError(where, 'not an object');
  }
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new RuleSetError(where, `unknown field "${key}"`);
  }

  const country = String(raw['country'] ?? '');
  if (!COUNTRY.test(country)) {
    throw new RuleSetError(where, `country "${country}" is not an ISO 3166-1 alpha-2 code`);
  }

  const list = raw['rules'];
  if (!Array.isArray(list) || list.length === 0) {
    throw new RuleSetError(where, 'rules is not a non-empty array');
  }

  const seen = new Set<string>();
  const rules = list.map((one, at) => {
    const rule = readRule(one, where, at);
    if (seen.has(rule.id)) {
      // Two rules under one id write the same thing into `categorised_by_set`,
      // and the screen can then name either of them as the reason.
      throw new RuleSetError(where, `two rules share the id "${rule.id}"`);
    }
    seen.add(rule.id);
    return rule;
  });

  // Sorted here rather than trusted from the file. Order is the whole semantics
  // of the engine, and a file whose rules happen to be listed in the wrong
  // order would categorise differently from the same file sorted - which is
  // exactly the kind of difference nobody would look for.
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const categories = [
    ...new Set(ordered.map((rule) => rule.category).filter((key) => key !== null)),
  ];

  return { country, categories, rules: ordered };
}

function readRule(value: unknown, where: string, at: number): SetRule {
  const place = `${where} rule ${String(at)}`;

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuleSetError(place, 'not an object');
  }
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) throw new RuleSetError(place, `unknown field "${key}"`);
  }

  const id = String(raw['id'] ?? '');
  if (!ID.test(id)) throw new RuleSetError(place, `id "${id}" is not kebab-case`);

  const name = String(raw['name'] ?? '').trim();
  if (name === '') throw new RuleSetError(place, 'name is missing');

  const priority = raw['priority'];
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    throw new RuleSetError(place, 'priority is missing, or is not a whole number');
  }

  return {
    id,
    name,
    priority,
    conditions: readConditions(raw['when'], place),
    ...readEffects(raw['then'], place),
    stopOnMatch: raw['stopOnMatch'] === true,
  };
}

function readConditions(value: unknown, where: string): RuleConditions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuleSetError(where, 'when is missing');
  }
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!WHEN_KEYS.has(key)) throw new RuleSetError(where, `when has an unknown field "${key}"`);
  }

  const pattern = raw['descriptionMatches'];
  if (pattern !== undefined && (typeof pattern !== 'string' || pattern.trim() === '')) {
    throw new RuleSetError(where, 'descriptionMatches is not a pattern');
  }
  if (typeof pattern === 'string') {
    // Compiled here rather than at the first statement that meets it. A shipped
    // expression that JavaScript refuses would otherwise be a rule that
    // silently matches nothing, for everybody, until somebody wondered why.
    try {
      new RegExp(pattern.startsWith('(?i)') ? pattern.slice(4) : pattern, 'iu');
    } catch {
      throw new RuleSetError(where, `descriptionMatches is not a valid expression: ${pattern}`);
    }
  }

  const bounds = raw['amountBetween'];
  if (bounds !== undefined) {
    if (!Array.isArray(bounds) || bounds.length !== 2) {
      throw new RuleSetError(where, 'amountBetween is not a pair');
    }
    for (const bound of bounds) {
      if (typeof bound !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(bound)) {
        throw new RuleSetError(where, `amountBetween holds "${String(bound)}", which is no amount`);
      }
    }
  }

  if (pattern === undefined && bounds === undefined) {
    // A rule with no condition matches every movement in the household.
    throw new RuleSetError(where, 'when states no condition, so it would match everything');
  }

  return {
    ...(typeof pattern === 'string' ? { descriptionMatches: pattern } : {}),
    ...(bounds === undefined ? {} : { amountBetween: bounds as [string, string] }),
  };
}

function readEffects(
  value: unknown,
  where: string,
): { category: CategoryKey | null; counterparty: string | null } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuleSetError(where, 'then is missing');
  }
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!THEN_KEYS.has(key)) throw new RuleSetError(where, `then has an unknown field "${key}"`);
  }

  const category = raw['category'];
  if (category !== undefined && !CATEGORY_KEYS.includes(category as CategoryKey)) {
    throw new RuleSetError(where, `no category called "${String(category)}"`);
  }

  const counterparty = raw['counterparty'];
  if (counterparty !== undefined && (typeof counterparty !== 'string' || counterparty === '')) {
    throw new RuleSetError(where, 'counterparty is not a name');
  }

  if (category === undefined && counterparty === undefined) {
    throw new RuleSetError(where, 'then does nothing');
  }

  return {
    category: (category as CategoryKey | undefined) ?? null,
    counterparty: (counterparty as string | undefined) ?? null,
  };
}
