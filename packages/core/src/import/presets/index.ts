import { FILE_FORMATS, formatLabel, type FileFormat } from '@altitude/shared';
import { looksLikeCamt, readCamt } from '../camt';
import { findHeaderRow, parseDelimited, sniffDelimiter } from '../csv';
import {
  mappingFits,
  readMapped,
  STATEMENT_ACCOUNT,
  STATEMENT_COUNTERPART,
  type ColumnMapping,
} from '../mapped';
import { looksLikeMt940, readMt940 } from '../mt940';
import { looksLikeOfx, readOfx } from '../ofx';
import { looksLikeQif, readQif } from '../qif';
import { looksLikeTradeRepublic, readTradeRepublic } from '../trade-republic';
import type { ImportReading } from '../types';
import {
  parsePresetDefinition,
  PresetError,
  type CodedReader,
  type PresetAccount,
  type PresetDefinition,
} from './schema';

import tradeRepublic from './de/trade-republic.json';

/**
 * Every preset file, in one place.
 *
 * Listed rather than found on disk, and the reason is the bundler. `core` runs
 * on a server and could read its own directory, but Next traces the files it
 * can see in an import and copies those - a `readdir` at startup finds an empty
 * folder in a production build and reports that this instance knows no banks.
 *
 * The cost is one line per bank, which is one line of TypeScript in a change
 * that is otherwise data. `presets.test.ts` reads the directory and fails with
 * the exact line to paste when a file is here and not there, so the way to
 * discover the omission is a test rather than an empty picker.
 */
const FILES: readonly (readonly [string, unknown])[] = [['de/trade-republic.json', tradeRepublic]];

/**
 * A reader that is code, keyed by the name a preset uses to reach it.
 *
 * The list is closed in `schema.ts` and the two must agree: a name there with
 * nothing here would pass validation and fail at read time. The test asserts
 * every declared reader is implemented.
 */
const CODED: Readonly<
  Record<CodedReader, { read: (text: string) => ImportReading; matches: (text: string) => boolean }>
> = {
  'trade-republic': { read: readTradeRepublic, matches: looksLikeTradeRepublic },
};

/**
 * A preset, resolved: what the file said, plus the two functions it implies.
 *
 * The distinction between a described bank and a coded one stops here. Every
 * step after the reading - binding accounts, deduplicating, previewing,
 * writing, undoing - works on this and never asks which kind it was.
 */
export interface Preset extends PresetDefinition {
  readonly read: (text: string) => ImportReading;
  /** Whether a file looks like this preset's, used to warn before reading it wrongly. */
  readonly matches: (text: string) => boolean;
  /** Always present once resolved: a described bank gets the two statement labels. */
  readonly accounts: Readonly<Record<string, PresetAccount>>;
}

/**
 * What a described statement's two labels mean.
 *
 * `readMapped` books every row between the account the statement is about and
 * the outside world, so those are the two a preset that describes columns has,
 * and no preset file needs to repeat them.
 */
const STATEMENT_ACCOUNTS: Readonly<Record<string, PresetAccount>> = {
  [STATEMENT_ACCOUNT]: { nameKey: 'statementAccount', kind: 'cash' },
  [STATEMENT_COUNTERPART]: { nameKey: 'outside', kind: 'cash' },
};

function resolve(where: string, value: unknown): Preset {
  const definition = parsePresetDefinition(value, where);

  if (definition.reader !== undefined) {
    const coded = CODED[definition.reader];
    return {
      ...definition,
      accounts: definition.accounts ?? {},
      read: coded.read,
      matches: coded.matches,
    };
  }

  // Guaranteed by the schema: a preset has a reader or a mapping.
  const mapping = definition.mapping!;
  const contains = definition.headerContains;

  return {
    ...definition,
    accounts: definition.accounts ?? STATEMENT_ACCOUNTS,
    read: (text) => readMapped(text, mapping),
    matches: (text) =>
      mappingFits(text, mapping) &&
      (contains === undefined || contains.every((name) => headerOf(text, mapping).includes(name))),
  };
}

/** The header row as this mapping would read it, for the extra names it asks about. */
function headerOf(text: string, mapping: ColumnMapping): readonly string[] {
  const rows = parseDelimited(text, mapping.delimiter ?? sniffDelimiter(text));
  return rows[mapping.headerRow ?? findHeaderRow(rows)] ?? [];
}

function load(): readonly Preset[] {
  const presets = FILES.map(([where, value]) => resolve(where, value));

  const seen = new Set<string>();
  for (const preset of presets) {
    if (seen.has(preset.id)) {
      // Two banks under one id is one bank: `presetById` returns the first and
      // the second is unreachable, which is a bad way to find out.
      throw new PresetError(preset.id, 'two presets share this id');
    }
    seen.add(preset.id);
  }

  // Sorted by name, so the picker does not reorder itself when a file is added.
  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The banks Altitude knows how to read.
 *
 * Built once, at load: a preset file that does not parse stops the process with
 * the field that is wrong, rather than being skipped and missed.
 */
export const PRESETS: readonly Preset[] = load();

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * The reader behind each format, or null where there is none.
 *
 * A `Record` over the whole of `FileFormat` rather than a `switch`, so a format
 * added to the list in `shared` is a compile error here until somebody says
 * what reads it. `delimited` is the one deliberate null: a delimited file is a
 * bank's own idea of a format, which is what presets and the mapping screen
 * are for.
 *
 * The currency is only QIF's. That format carries none at all, and the plan
 * says it is asked for at import time - so it arrives from the screen rather
 * than being guessed, and QIF is the one reader whose result depends on an
 * answer that is not in the file.
 */
const READERS: Readonly<
  Record<
    FileFormat,
    {
      read: (text: string, currency: string) => ImportReading;
      matches: (text: string) => boolean;
    } | null
  >
> = {
  delimited: null,
  ofx: { read: readOfx, matches: looksLikeOfx },
  camt: { read: readCamt, matches: looksLikeCamt },
  mt940: { read: readMt940, matches: looksLikeMt940 },
  qif: { read: readQif, matches: looksLikeQif },
};

/**
 * The preset for a file that needs no preset.
 *
 * OFX, CAMT.053 and MT940 are formats rather than banks: the file says what
 * every value is, so there is nothing to name and nothing to remember between
 * imports (§8.1, "mapping is deterministic, no mapping screen needed"). A bank
 * that exports one of them is covered without anybody writing anything. QIF
 * joins them with an asterisk, being the one that carries no currency.
 *
 * Still a `Preset`, for the same reason `customPreset` is: everything after the
 * reading - binding accounts, deduplicating, previewing, writing, undoing -
 * then works on it unchanged. The id lands in `imports.source`, so the history
 * says `camt` where another run says `trade-republic`, which is exactly as much
 * as is true about where it came from.
 */
export function formatPreset(format: FileFormat, currency: string): Preset | null {
  const reader = READERS[format];
  if (reader === null) return null;

  return {
    id: format,
    // Named from `shared`, where the browser reads the same two strings the
    // moment a file is dropped. Two lists would disagree eventually, and the
    // disagreement would be a badge saying one thing and a history row another.
    ...formatLabel(format),
    country: 'XX',
    accounts: STATEMENT_ACCOUNTS,
    read: (text) => reader.read(text, currency),
    matches: reader.matches,
  };
}

/**
 * The same, addressed the way a request addresses it.
 *
 * The id is checked against the format list rather than against a hand-written
 * set, so a format added above is reachable from a request without anybody
 * remembering to widen a condition here. `formats.test.ts` asserts the two
 * directions agree.
 */
export function formatPresetById(id: string, currency: string): Preset | null {
  const format = FILE_FORMATS.find((one) => one === id);
  return format === undefined ? null : formatPreset(format, currency);
}

/**
 * The id of the bank nobody wrote a preset for.
 *
 * Not in `PRESETS`: it has no reader until somebody describes their file, and
 * listing it there would put an entry in the picker that cannot read anything.
 * The screen offers it separately and builds one once the columns are named.
 *
 * Mirrored in `apps/web/src/lib/import-custom.ts`, which a client component can
 * import - this module reaches the readers, which reach the database driver.
 * A test asserts the two stay equal.
 */
export const CUSTOM_PRESET_ID = 'custom';

/**
 * A preset built from a mapping somebody just wrote, rather than from a file.
 *
 * A synthetic preset rather than a branch through the import actions. Every
 * step after the reading then works on it without knowing it is different,
 * which is the whole reason a described bank and a coded one produce the same
 * `ImportReading`.
 *
 * The same shape a contributed preset has, which is what makes "save this as a
 * preset" a serialisation rather than a translation.
 */
export function customPreset(mapping: ColumnMapping): Preset {
  return {
    id: CUSTOM_PRESET_ID,
    name: 'custom',
    // The user-assigned ISO code, which is as much as anyone knows: this
    // mapping was written a minute ago against a file from an unnamed bank.
    country: 'XX',
    monogram: 'CSV',
    mapping,
    accounts: STATEMENT_ACCOUNTS,
    read: (text) => readMapped(text, mapping),
    matches: (text) => mappingFits(text, mapping),
  };
}
