import { dec } from '@altitude/shared';
import { normaliseLabel } from '../import/labels';

/**
 * Deciding what a movement was for, by rules a person can read.
 *
 * Ordered, deterministic and inspectable, with no statistical model (plan
 * §8.6). Every categorisation can be traced to one rule, which is what makes
 * "why is this in groceries" a question with an answer - and what makes
 * changing the answer a matter of editing one line rather than retraining
 * something.
 *
 * Patterns are matched against the normalised label, not the raw one: a rule
 * written in March has to still work in September, and the raw text carries a
 * date and a card number that change every month. Accents are stripped from
 * the pattern too, so a rule saying "intermarché" matches a statement that
 * wrote INTERMARCHE.
 */

export interface RuleConditions {
  /** A regular expression, read against the normalised label. Case is ignored. */
  readonly descriptionMatches?: string;
  /** Inclusive bounds, as exact decimal strings. Signed: a purchase is negative. */
  readonly amountBetween?: readonly [string, string];
  /** Only entries on this account. */
  readonly accountId?: string;
}

export interface CategorisationRule {
  readonly id: string;
  readonly name: string;
  /** Lower runs first. */
  readonly priority: number;
  readonly conditions: RuleConditions;
  /**
   * What a match does. A rule needs at least one of these and may have all.
   *
   * They are three different kinds of answer. A category is exclusive - one per
   * entry - so categories sum to the total. A counterparty is a name, and
   * answers what no category can: how much at this shop. Tags are neither, and
   * a movement carries as many as somebody wants.
   */
  readonly categoryId: string | null;
  readonly counterparty: string | null;
  readonly tagIds: readonly string[];
  /** Whether a match ends the pass. */
  readonly stopOnMatch: boolean;
  /**
   * Whether this rule is the household's or a shipped one.
   *
   * The plan orders them: "user rules first, then a community rule set per
   * country" (§8.6). Order alone would not be enough - a later rule replaces an
   * earlier one, so a shipped rule reached after a household's would overrule
   * it, which is the opposite of what "first" means. So a shipped rule only
   * fills what is still empty, and what somebody wrote about their own
   * statements always wins.
   *
   * Absent means the household's, because that is what every rule was before
   * sets existed and what most of them still are.
   */
  readonly source?: 'household' | 'set';
}

/** One entry, as the engine sees it. */
export interface Categorisable {
  readonly description: string | null;
  /** The entry's own amount, signed. */
  readonly amount: string;
  readonly accountId: string;
  /**
   * The account's class.
   *
   * `equity` is the edge of the household: the counterpart every purchase
   * needs, where money comes from and goes to. Categorising that side would
   * count the same spending twice, which is the same reason net worth leaves
   * equity out.
   */
  readonly accountClass: string;
}

export interface Categorised {
  readonly categoryId: string | null;
  /**
   * The rule that decided the category, so a later pass can tell its own work
   * from a person's and the screen can say which one.
   */
  readonly ruleId: string | null;
  /**
   * Which kind of rule that was, because they are stored in different columns.
   *
   * A household's rule is a row, and `entries.categorised_by` references it so
   * that deleting the rule lets go of what it decided. A shipped rule is a file
   * with no row to reference and none to delete, so it goes in a column of its
   * own. Null when nothing set a category.
   */
  readonly ruleSource: 'household' | 'set' | null;
  readonly counterparty: string | null;
  /** Every tag every matching rule asked for, in the order first seen. */
  readonly tagIds: readonly string[];
}

/**
 * A pattern long enough to be slow is refused rather than run.
 *
 * A rule is written by somebody categorising their own statements, so this is
 * not a hostile input in the usual sense - but a catastrophically backtracking
 * expression would hang the import for the household that wrote it, and there
 * is no way to interrupt a regular expression once it is running.
 */
const MAX_PATTERN = 200;

/**
 * The pattern as JavaScript can run it.
 *
 * A leading `(?i)` is dropped rather than refused. It is what the plan's own
 * example writes and what anyone used to other languages will type, and
 * JavaScript throws on it - so the flag it asks for is simply applied.
 */
function compile(pattern: string): RegExp | null {
  if (pattern.length > MAX_PATTERN) return null;
  const body = pattern.startsWith('(?i)') ? pattern.slice(4) : pattern;
  try {
    return new RegExp(stripAccents(body), 'iu');
  } catch {
    return null;
  }
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** Whether one rule describes this entry. Every stated condition has to hold. */
function fits(rule: CategorisationRule, line: Categorisable, label: string): boolean {
  const { descriptionMatches, amountBetween, accountId } = rule.conditions;

  if (accountId !== undefined && accountId !== line.accountId) return false;

  if (amountBetween !== undefined) {
    const amount = dec(line.amount);
    if (amount.lessThan(dec(amountBetween[0])) || amount.greaterThan(dec(amountBetween[1]))) {
      return false;
    }
  }

  if (descriptionMatches !== undefined) {
    const pattern = compile(descriptionMatches);
    // A rule nobody can run matches nothing. Refusing it here rather than
    // throwing keeps one bad expression from failing a whole import.
    if (pattern === null || !pattern.test(label)) return false;
  }

  return true;
}

/**
 * What the rules make of this entry, or null when none describes it.
 *
 * Rules are taken in the order given, which the caller sorts by priority. A
 * rule with `stopOnMatch` ends the pass; without it the pass continues and a
 * later rule may take over, which is how a broad rule and a narrow one live
 * together.
 *
 * The three effects accumulate differently, and deliberately. A category and a
 * counterparty are single values, so a later rule replaces an earlier one -
 * "everything from this shop is groceries, except the line that is rent". Tags
 * are a set, so they add up: a rule that tags every purchase abroad and a rule
 * that tags every restaurant both apply to dinner in Madrid.
 */
export function categorise(
  line: Categorisable,
  rules: readonly CategorisationRule[],
): Categorised | null {
  if (line.accountClass === 'equity') return null;

  const label = line.description === null ? '' : normaliseLabel(line.description);

  let categoryId: string | null = null;
  let ruleId: string | null = null;
  let ruleSource: 'household' | 'set' | null = null;
  let counterparty: string | null = null;
  const tagIds = new Set<string>();
  let matched = false;

  for (const rule of rules) {
    if (!fits(rule, line, label)) continue;
    matched = true;

    // A shipped rule fills what is still empty and never replaces. That is the
    // whole of "user rules first, then the set": a household that has said
    // what a movement is has said it, and an update that changed a shipped
    // pattern must not quietly change their answer with it.
    const fillsOnly = rule.source === 'set';

    if (rule.categoryId !== null && !(fillsOnly && categoryId !== null)) {
      categoryId = rule.categoryId;
      ruleId = rule.id;
      ruleSource = rule.source ?? 'household';
    }
    if (rule.counterparty !== null && !(fillsOnly && counterparty !== null)) {
      counterparty = rule.counterparty;
    }
    // Tags are a set and only a household has any, so there is nothing here for
    // a shipped rule to overrule.
    for (const tag of rule.tagIds) tagIds.add(tag);

    if (rule.stopOnMatch) break;
  }

  return matched ? { categoryId, ruleId, ruleSource, counterparty, tagIds: [...tagIds] } : null;
}

/**
 * Words a statement puts in front of every line, which identify nothing.
 *
 * French and English both, because a household may bank in either and the
 * cost of a word that does not appear is nothing. Not exhaustive and not
 * meant to be: this feeds a suggestion somebody edits, not a decision.
 */
const BOILERPLATE = new Set([
  'CARTE',
  'CB',
  'PAIEMENT',
  'PAYMENT',
  'ACHAT',
  'VIR',
  'VIREMENT',
  'TRANSFER',
  'PRLV',
  'PRELEVEMENT',
  'SEPA',
  'RETRAIT',
  'DAB',
  'FACTURE',
  'ABONNEMENT',
  'DU',
  'DE',
  'DES',
  'LA',
  'LE',
  'LES',
  'ET',
  'AU',
  'AUX',
  'PAR',
  'POUR',
  'SUR',
  'THE',
  'FROM',
  'TO',
]);

/**
 * A starting point for a rule, from one description.
 *
 * The plan asks that recategorising a transaction offer a rule for all
 * similar descriptions (§8.6). Offering the whole label would produce a rule
 * matching exactly one line; what identifies a shop is the two words left once
 * the bank's own vocabulary, the dates and the reference numbers are gone.
 *
 * A suggestion, never an action. Somebody reads it, edits it, and decides.
 */
export function suggestPattern(description: string): string {
  const words = normaliseLabel(description)
    .split(' ')
    .filter(
      (word) => word !== '' && word !== '#' && !BOILERPLATE.has(word) && !/^[0-9]+$/u.test(word),
    );

  return words.slice(0, 2).join(' ');
}

/**
 * Conditions read back from the database, or null when this version cannot use
 * them.
 *
 * Hand-written rather than a schema library, for the same reason `parseMapping`
 * is: the shape is small, the failure has to be silent-but-safe rather than an
 * exception, and a dependency to describe three optional fields is not a
 * trade this repository makes. A row that does not parse is treated as absent
 * and left where it is - an older or hand-edited row is somebody's intent.
 */
export function parseConditions(raw: unknown): RuleConditions | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const conditions: {
    descriptionMatches?: string;
    amountBetween?: readonly [string, string];
    accountId?: string;
  } = {};

  const description = source['descriptionMatches'];
  if (description !== undefined) {
    if (typeof description !== 'string' || description === '') return null;
    // Compiled now rather than at every entry of every import, and a rule that
    // cannot be compiled is not a rule.
    if (compile(description) === null) return null;
    conditions.descriptionMatches = description;
  }

  const between = source['amountBetween'];
  if (between !== undefined) {
    if (!Array.isArray(between) || between.length !== 2) return null;
    const [low, high] = between as unknown[];
    if (typeof low !== 'string' || typeof high !== 'string') return null;
    if (!isDecimal(low) || !isDecimal(high)) return null;
    if (dec(low).greaterThan(dec(high))) return null;
    conditions.amountBetween = [low, high];
  }

  const account = source['accountId'];
  if (account !== undefined) {
    if (typeof account !== 'string' || account === '') return null;
    conditions.accountId = account;
  }

  // A rule with no condition would take every entry it was offered, which is
  // never what somebody meant to write.
  if (Object.keys(conditions).length === 0) return null;
  return conditions;
}

function isDecimal(value: string): boolean {
  try {
    return dec(value).isFinite();
  } catch {
    return false;
  }
}
