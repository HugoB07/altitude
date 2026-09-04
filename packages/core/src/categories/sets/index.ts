import { parseRuleSet, RuleSetError, type RuleSet } from './schema';

import fr from './fr.json';

/**
 * Every rule set, in one place.
 *
 * Listed rather than found on disk, for the reason the preset registry gives:
 * Next ships the files it can see in an import, and a directory read at startup
 * finds an empty folder in a production build. `sets.test.ts` reads the
 * directory and fails with the line to paste when a file is here and not there.
 */
const FILES: readonly (readonly [string, unknown])[] = [['fr.json', fr]];

function load(): Readonly<Record<string, RuleSet>> {
  const sets: Record<string, RuleSet> = {};

  for (const [where, value] of FILES) {
    const set = parseRuleSet(value, where);
    const country = set.country.toLowerCase();

    if (sets[country] !== undefined) {
      throw new RuleSetError(where, `a second set claims ${set.country}`);
    }
    if (`${country}.json` !== where) {
      // The file's name is its country, so a household storing `fr` finds the
      // set without a lookup table nobody would remember to update.
      throw new RuleSetError(where, `declares ${set.country}, so it should be ${country}.json`);
    }

    sets[country] = set;
  }

  return sets;
}

/**
 * The community rule sets, keyed by the country a household stores.
 *
 * Built once, at load: a file that does not parse stops the process naming the
 * rule that is wrong, rather than being skipped and shipping a set that
 * silently categorises less than it should.
 */
export const RULE_SETS: Readonly<Record<string, RuleSet>> = load();

/** Which sets exist, for the screen that offers them. Sorted, so the list is stable. */
export const RULE_SET_COUNTRIES: readonly string[] = Object.keys(RULE_SETS).sort();

export function ruleSetFor(country: string | null): RuleSet | undefined {
  return country === null ? undefined : RULE_SETS[country.toLowerCase()];
}
