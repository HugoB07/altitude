import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORY_KEYS, RULE_SETS, RULE_SET_COUNTRIES } from '@altitude/core';

/**
 * A shipped rule names a category by key, and a key is not a name.
 *
 * That is what lets one file serve a French household and an English one: the
 * name is written in the reader's language here, on this side of the boundary.
 * The cost is that a key with no message reaches a screen as `key.groceries`,
 * which is the one thing a bilingual application cannot do (ADR-0010) - and the
 * two halves live in different packages, so nothing but this joins them.
 */
const MESSAGES = join(import.meta.dirname, '..', 'messages');

function catalogue(locale: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8'));
  const all = raw as { categories?: Record<string, unknown> };
  return all.categories ?? {};
}

describe.each(['en', 'fr'])('the %s catalogue', (locale) => {
  const categories = catalogue(locale);
  const keys = (categories['key'] ?? {}) as Record<string, string>;
  const countries = (categories['country'] ?? {}) as Record<string, string>;

  it('names every category a rule set may point at', () => {
    expect(CATEGORY_KEYS.filter((key) => (keys[key] ?? '').trim() === '')).toEqual([]);
  });

  it('names every country that ships a set', () => {
    expect(RULE_SET_COUNTRIES.filter((code) => (countries[code] ?? '').trim() === '')).toEqual([]);
  });

  it('has no name for a key nothing uses', () => {
    // The other direction, so the list shrinks when a key is retired rather
    // than leaving a message nobody can reach.
    expect(Object.keys(keys).filter((key) => !CATEGORY_KEYS.includes(key as never))).toEqual([]);
  });
});

describe('the shipped sets', () => {
  it('only point at categories the application can name', () => {
    // Enforced by the loader too, which refuses a file naming an unknown key.
    // Repeated here because this is where the consequence is visible: a key
    // with no message is a category shown as its own identifier.
    for (const [country, set] of Object.entries(RULE_SETS)) {
      expect(
        set.categories.filter((key) => !CATEGORY_KEYS.includes(key)),
        `${country} names a category the application does not know`,
      ).toEqual([]);
    }
  });
});
