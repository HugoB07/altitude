import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two catalogues, held to being the same catalogue.
 *
 * ADR-0010 puts both languages on the first screen and neither behind a flag,
 * so a key that exists in one and not the other is not a missing translation:
 * it is a screen that renders `import.yearAssumed` at somebody. CONTRIBUTING
 * claimed for a while that this was checked mechanically. It was not - the
 * catalogues agreed by care, across four hundred keys and several sessions of
 * adding them by hand, which is not a property anyone can keep indefinitely.
 *
 * Three things are compared, and the third is the one that would have gone
 * unnoticed longest. A French string that drops `{year}` from an interpolation
 * is not missing; it is a sentence about a year with no year in it, and every
 * test of the French half passes.
 */
const MESSAGES = join(import.meta.dirname, '..', 'messages');

type Catalogue = Record<string, unknown>;

function load(locale: string): Catalogue {
  return JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8')) as Catalogue;
}

/** Every leaf, keyed by its dotted path. */
function flatten(catalogue: Catalogue, prefix = ''): Map<string, string> {
  const found = new Map<string, string>();

  for (const [key, value] of Object.entries(catalogue)) {
    const path = `${prefix}${key}`;
    if (typeof value === 'string') found.set(path, value);
    else if (typeof value === 'object' && value !== null) {
      for (const [inner, text] of flatten(value as Catalogue, `${path}.`)) found.set(inner, text);
    }
  }

  return found;
}

/** What ICU puts before a branch: `=0`, `one`, `other`. */
const SELECTOR = /(?:=\d+|zero|one|two|few|many|other)$/u;

/**
 * The names a message interpolates.
 *
 * Harder than it looks, and a first version of this reported eight differences
 * that were not. `{count, plural, =1 {line} other {lines}}` names one argument,
 * `count`; `{line}` and `{lines}` are branch text that happens to be a single
 * word, and taking every `{word}` for an argument makes every plural in the
 * catalogue differ from its translation - which is noise loud enough to have
 * the check turned off.
 *
 * The two are told apart by what precedes the brace. A branch body follows its
 * selector; anything else opening a brace is a placeholder. Nothing here parses
 * ICU properly, and nothing needs to: the question is only which names a
 * message uses.
 */
function arguments_(text: string): Set<string> {
  const found = new Set<string>();

  for (const match of text.matchAll(/\{\s*(\w+)/gu)) {
    const before = text.slice(0, match.index).trimEnd();
    if (!SELECTOR.test(before)) found.add(match[1]!);
  }

  return found;
}

const en = flatten(load('en'));
const fr = flatten(load('fr'));

describe('the English and French catalogues', () => {
  it('hold the same keys', () => {
    const missing = [...en.keys()].filter((key) => !fr.has(key));
    const extra = [...fr.keys()].filter((key) => !en.has(key));

    expect(missing, 'in en.json and not in fr.json').toEqual([]);
    expect(extra, 'in fr.json and not in en.json').toEqual([]);
  });

  it('leave nothing blank', () => {
    // A key present and empty renders as nothing at all, which on a button is
    // a button nobody can name and on an error is silence.
    const blank = [...en, ...fr].filter(([, text]) => text.trim() === '').map(([key]) => key);

    expect(blank).toEqual([]);
  });

  it('interpolate the same names in both', () => {
    // The one that hides. A French sentence that lost `{year}` still renders,
    // still reads as a sentence, and is missing the number it was written to
    // carry - and next-intl does not complain about an argument nobody used.
    const differing = [...en]
      .filter(([key, text]) => {
        const other = fr.get(key);
        if (other === undefined) return false;

        const mine = arguments_(text);
        const theirs = arguments_(other);
        return mine.size !== theirs.size || [...mine].some((name) => !theirs.has(name));
      })
      .map(([key]) => key);

    expect(differing).toEqual([]);
  });

  it('found enough to be worth checking', () => {
    // A flattener that returned nothing would pass all three above.
    expect(en.size).toBeGreaterThan(300);
  });
});
