import { parseMapping, type ColumnMapping } from '../mapped';

/**
 * What a bank is, written down rather than compiled in.
 *
 * The plan is explicit about why (§8.4): "a preset is data, not code. Adding a
 * bank requires no compilation and no knowledge of the core - that is what
 * makes coverage community-extensible." Somebody holding a statement from a
 * bank nobody here has an account with can describe it, and the description is
 * a file rather than a pull request against a reader.
 *
 * Two kinds live side by side, and the difference is a fact about the export
 * rather than about how much work went in. A statement is one row per movement,
 * and naming its columns describes it completely. A broker export is not: a
 * transfer between two of your own accounts is two rows to pair, a purchase
 * carries an ISIN and a quantity and splits into cash and holding, and interest
 * arrives with tax already deducted. No arrangement of column names says any of
 * that, so those presets name a reader instead of describing columns - and are
 * still a file, so what exists is in one place and one format.
 */

/**
 * The account kinds a preset may ask to open.
 *
 * Narrower than what the ledger allows: a preset says what a bank's product is,
 * and no bank's product is an opening balance or a house.
 */
export const PRESET_ACCOUNT_KINDS = ['cash', 'securities', 'savings'] as const;
export type PresetAccountKind = (typeof PRESET_ACCOUNT_KINDS)[number];

export interface PresetAccount {
  /**
   * A key under the `import.account` namespace, not a name.
   *
   * A reader speaks the file's vocabulary, and the file's vocabulary is
   * `DEFAULT` and `PEA`. That is fine inside the code and useless on screen:
   * somebody was asked "which of your accounts is DEFAULT?" and had no way to
   * know. The preset knows, because knowing this bank is what a preset is - and
   * a key rather than a name so the answer is in the reader's language.
   */
  readonly nameKey: string;
  /** The kind to create it as, when nobody has an account for it yet. */
  readonly kind: PresetAccountKind;
  /**
   * Whether this account holds its cash and its shares together.
   *
   * A reader splits every trade into a cash side and a securities side, because
   * for most accounts those are two places: money leaves the current account
   * and shares arrive in the brokerage account beside it. A French PEA is not
   * like that. It is one account with cash and holdings inside it, and asking a
   * person to name a separate "PEA securities" account asks them to invent one.
   *
   * A fact about a bank's own product, which is why it lives in a preset. Trade
   * Republic keeps a current account and a CTO apart and keeps a PEA whole;
   * another bank splits them all, and a third splits none.
   */
  readonly holdsSharesToo?: boolean;
}

/**
 * The readers a preset may point at, for a file no mapping describes.
 *
 * A closed list, checked at load: a preset naming a reader that does not exist
 * would otherwise be a bank in the picker that reads nothing, found by whoever
 * clicked it rather than by the test suite.
 */
export const CODED_READERS = ['trade-republic'] as const;
export type CodedReader = (typeof CODED_READERS)[number];

export interface PresetDefinition {
  /**
   * Kebab-case, stable, and stored on every import this preset produces.
   *
   * Renaming one is a data migration rather than a rename: `imports.source`
   * holds it, and the history screen reads it back months later.
   */
  readonly id: string;
  readonly name: string;
  /** ISO 3166-1 alpha-2, and the directory this file sits in. */
  readonly country: string;
  /**
   * Two or three letters, drawn as a tile when there is no logo file.
   *
   * A bank's logo is a trademark, and bundling one in an AGPL repository is a
   * licensing question rather than a design one. A monogram is neither, works
   * offline like everything else here, and leaves `logo` free for the day a
   * particular mark is cleared to ship.
   */
  readonly monogram: string;
  /** A file under `public/banks/`. Never a remote URL: an offline instance must render. */
  readonly logo?: string;
  /** Named on accounts this import creates, so a person can see where they came from. */
  readonly institution?: string;
  /** For an export no arrangement of column names describes. Excludes `mapping`. */
  readonly reader?: CodedReader;
  /** Which column is what. Excludes `reader`. */
  readonly mapping?: ColumnMapping;
  /**
   * Column names that identify this bank's file, beyond the ones it maps.
   *
   * Optional, and only for a mapping. Recognition already tests the mapped
   * columns, which settles most files; two banks writing `date;label;amount`
   * are the case it does not, and a name only one of them uses separates them.
   */
  readonly headerContains?: readonly string[];
  /** What the exporter's own account codes mean. Defaulted for a mapping. */
  readonly accounts?: Readonly<Record<string, PresetAccount>>;
}

/**
 * A preset file that cannot be trusted, named.
 *
 * Thrown rather than returned as null, and that is deliberate. These are files
 * in the repository, read once at startup: a null would drop a bank quietly and
 * be found by whoever went looking for it in the picker, while a throw is
 * caught by the test that reads every file before anything ships.
 */
export class PresetError extends Error {
  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = 'PresetError';
  }
}

/** Everything a preset file may say. Anything else is a typo. */
const KEYS = new Set([
  '$comment',
  'id',
  'name',
  'country',
  'monogram',
  'logo',
  'institution',
  'reader',
  'mapping',
  'headerContains',
  'accounts',
]);

const ACCOUNT_KEYS = new Set(['nameKey', 'kind', 'holdsSharesToo']);

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COUNTRY = /^[A-Z]{2}$/;

/**
 * A preset file, checked before anything trusts it.
 *
 * Hand-written rather than a schema library, for the reason CONTRIBUTING gives:
 * `packages/core` takes a dependency only with a reason, and a hundred lines
 * that read like the type they check is a poor one.
 *
 * Unknown keys are refused. JSON has no compiler, so `acounts` or `mappings`
 * would otherwise be a field that silently does nothing - which is the whole
 * failure mode of moving code into data, and the one thing this has to catch.
 * `$comment` is allowed through and ignored, because JSON has no comments and a
 * preset occasionally needs to explain a choice nobody would guess.
 */
export function parsePresetDefinition(value: unknown, where: string): PresetDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PresetError(where, 'not an object');
  }
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new PresetError(where, `unknown field "${key}"`);
  }

  const id = text(raw['id'], where, 'id');
  if (!ID.test(id)) throw new PresetError(where, `id "${id}" is not kebab-case`);

  const name = text(raw['name'], where, 'name');
  const country = text(raw['country'], where, 'country');
  if (!COUNTRY.test(country)) {
    throw new PresetError(where, `country "${country}" is not an ISO 3166-1 alpha-2 code`);
  }

  const monogram = text(raw['monogram'], where, 'monogram');
  if (monogram.length > 3) throw new PresetError(where, 'monogram is longer than three letters');

  const logo = optionalText(raw['logo'], where, 'logo');
  if (logo !== undefined && !logo.startsWith('/')) {
    throw new PresetError(where, 'logo is not a path under public/ - a remote URL never loads');
  }
  const institution = optionalText(raw['institution'], where, 'institution');

  const reader = raw['reader'];
  if (reader !== undefined && !CODED_READERS.includes(reader as CodedReader)) {
    throw new PresetError(where, `no reader called "${String(reader)}"`);
  }

  // One or the other, never both and never neither. Both would leave the loader
  // choosing which to believe; neither is a bank that reads nothing.
  const hasMapping = raw['mapping'] !== undefined;
  if (hasMapping === (reader !== undefined)) {
    throw new PresetError(where, 'needs exactly one of "reader" and "mapping"');
  }

  const mapping = hasMapping ? parseMapping(raw['mapping']) : null;
  if (hasMapping && mapping === null) {
    throw new PresetError(where, 'the mapping names no booking date, or no single amount');
  }

  const headerContains = readHeaderContains(raw['headerContains'], where);
  if (headerContains !== undefined && reader !== undefined) {
    throw new PresetError(where, 'a coded reader recognises its own files - drop headerContains');
  }

  return {
    id,
    name,
    country,
    monogram,
    ...(logo === undefined ? {} : { logo }),
    ...(institution === undefined ? {} : { institution }),
    ...(reader === undefined ? {} : { reader: reader as CodedReader }),
    ...(mapping === null ? {} : { mapping }),
    ...(headerContains === undefined ? {} : { headerContains }),
    ...(raw['accounts'] === undefined ? {} : { accounts: readAccounts(raw['accounts'], where) }),
  };
}

function text(value: unknown, where: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PresetError(where, `${field} is missing`);
  }
  return value.trim();
}

function optionalText(value: unknown, where: string, field: string): string | undefined {
  return value === undefined ? undefined : text(value, where, field);
}

function readHeaderContains(value: unknown, where: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new PresetError(where, 'headerContains is not a non-empty array');
  }
  return value.map((name, index) => text(name, where, `headerContains[${index}]`));
}

function readAccounts(value: unknown, where: string): Readonly<Record<string, PresetAccount>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PresetError(where, 'accounts is not an object');
  }

  const accounts: Record<string, PresetAccount> = {};
  for (const [label, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PresetError(where, `account "${label}" is not an object`);
    }
    const account = raw as Record<string, unknown>;

    for (const key of Object.keys(account)) {
      if (!ACCOUNT_KEYS.has(key)) {
        throw new PresetError(where, `account "${label}" has an unknown field "${key}"`);
      }
    }

    const kind = account['kind'];
    if (!PRESET_ACCOUNT_KINDS.includes(kind as PresetAccountKind)) {
      throw new PresetError(where, `account "${label}" has no kind, or an unknown one`);
    }

    const holdsSharesToo = account['holdsSharesToo'];
    if (holdsSharesToo !== undefined && typeof holdsSharesToo !== 'boolean') {
      throw new PresetError(where, `account "${label}" has a non-boolean holdsSharesToo`);
    }

    accounts[label] = {
      nameKey: text(account['nameKey'], where, `account "${label}" nameKey`),
      kind: kind as PresetAccountKind,
      ...(holdsSharesToo === undefined ? {} : { holdsSharesToo }),
    };
  }

  return accounts;
}
