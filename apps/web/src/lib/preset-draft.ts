/**
 * A mapping that just worked, as the file that would ship it.
 *
 * The last step the README has been promising: a bank described once on the
 * mapping screen is described for that person and nobody else, and turning it
 * into a preset was a job for whoever could write TypeScript. Now a preset is
 * a JSON file, so it is a job for whoever holds the statement - this writes the
 * file for them, and they attach it to a pull request.
 *
 * Pure, with no imports, because a client component calls it: the preset
 * registry reaches the readers, which reach the database driver, and the build
 * stops at "can't resolve 'fs'" (see `client-boundary.test.ts`).
 *
 * Nothing from the file itself goes in - only the names of its columns, which
 * say which bank it came from and nothing about what is in it. The sample a
 * contribution also needs is a separate, deliberate act, and CONTRIBUTING's
 * anonymisation checklist is about that one.
 */

export interface PresetDraft {
  /** What the person calls their bank. Everything else is derived from it. */
  readonly name: string;
  /** ISO 3166-1 alpha-2, as typed: compared case-insensitively, written upper. */
  readonly country: string;
  /** The `ColumnMapping` the screen built, exactly as it sends it to the server. */
  readonly mapping: unknown;
}

export interface PresetFileDraft {
  readonly id: string;
  /** Where it goes in the repository, ready to paste next to a `git add`. */
  readonly path: string;
  readonly json: string;
}

const COUNTRY = /^[A-Za-z]{2}$/;

/**
 * The file, or null when there is not enough to write one.
 *
 * Null rather than a partial file: a preset with an empty id fails to load, and
 * the failure would land on whoever reviewed the pull request rather than on
 * the person who could still fix it by typing a name.
 */
export function presetFileDraft(draft: PresetDraft): PresetFileDraft | null {
  const id = slug(draft.name);
  const country = draft.country.trim().toUpperCase();

  if (id === '' || !COUNTRY.test(country)) return null;

  const contents = {
    id,
    name: draft.name.trim(),
    country,
    monogram: monogram(draft.name),
    institution: draft.name.trim(),
    mapping: draft.mapping,
  };

  return {
    id,
    path: `packages/core/src/import/presets/${country.toLowerCase()}/${id}.json`,
    json: `${JSON.stringify(contents, null, 2)}\n`,
  };
}

/** The id, which is also the filename. Kebab-case, which the loader enforces. */
function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * Two letters, drawn as a tile until somebody clears a logo to ship.
 *
 * Initials of the first two words, or the first two letters of a single one.
 * "Crédit Agricole" is CA and "Fortuneo" is FO, which is what a person would
 * have written themselves - and one field fewer to ask about.
 */
function monogram(name: string): string {
  const words = slug(name)
    .split('-')
    .filter((word) => word !== '');

  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}
