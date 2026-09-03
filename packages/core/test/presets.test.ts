import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import {
  CODED_READERS,
  CUSTOM_PRESET_ID,
  PRESETS,
  PresetError,
  customPreset,
  parsePresetDefinition,
  presetById,
} from '../src/index';

/**
 * The preset files, read as files.
 *
 * The plan's §8.4 is a promise about who can add a bank: "a preset is data, not
 * code. Adding a bank requires no compilation and no knowledge of the core."
 * That promise is only kept if a dropped-in file actually reaches the picker
 * and actually reads its own sample - so this walks the directory rather than
 * the registry, and every check below starts from what is on disk.
 */
const PRESET_DIR = join(import.meta.dirname, '..', 'src', 'import', 'presets');
const FIXTURES = join(import.meta.dirname, 'presets');

interface PresetFile {
  /** `de/trade-republic.json`, the path a contributor sees. */
  readonly path: string;
  readonly country: string;
  readonly id: string;
}

function presetFiles(): readonly PresetFile[] {
  const found: PresetFile[] = [];

  for (const country of readdirSync(PRESET_DIR, { withFileTypes: true })) {
    if (!country.isDirectory()) continue;

    for (const entry of readdirSync(join(PRESET_DIR, country.name))) {
      if (!entry.endsWith('.json')) continue;
      found.push({
        path: `${country.name}/${entry}`,
        country: country.name,
        id: entry.slice(0, -'.json'.length),
      });
    }
  }

  return found;
}

const FILES = presetFiles();

describe('the preset directory', () => {
  it('found some, so the checks below mean something', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('registers every file it holds', () => {
    // The one line of TypeScript a new bank costs. Listed rather than read from
    // disk at runtime because Next only ships the files it can see in an import
    // - so this is where a forgotten line is found, with the line to paste.
    const missing = FILES.filter((file) => presetById(file.id) === undefined).map(
      (file) => `['${file.path}', ${file.id.replace(/-(.)/g, (_, c: string) => c.toUpperCase())}]`,
    );

    expect(missing, 'add these to FILES in src/import/presets/index.ts').toEqual([]);
  });

  it('holds a file for every registered preset', () => {
    const paths = new Set(FILES.map((file) => file.id));
    expect(PRESETS.filter((preset) => !paths.has(preset.id)).map((preset) => preset.id)).toEqual(
      [],
    );
  });

  it('names each file after its id, in the directory of its country', () => {
    for (const file of FILES) {
      const preset = presetById(file.id);
      expect(preset?.id, `${file.path} declares an id that is not its filename`).toBe(file.id);
      expect(preset?.country, `${file.path} sits in the wrong country`).toBe(
        file.country.toUpperCase(),
      );
    }
  });

  it('leaves no coded reader without a preset to reach it', () => {
    // A reader nothing points at is unreachable: the picker is built from the
    // files, so code with no file is code nobody can run.
    const used = new Set(PRESETS.map((preset) => preset.reader).filter(Boolean));
    expect(CODED_READERS.filter((name) => !used.has(name))).toEqual([]);
  });
});

/**
 * Every preset reads its own sample, and produces exactly what it should.
 *
 * The plan asks for this per preset (§8.4: "every preset ships with an
 * anonymised sample file and a test asserting the expected result"), and the
 * reason is that a preset is data: nothing else would notice a column renamed
 * in the JSON, because a mapping that names a column no file has produces an
 * empty reading rather than an error.
 *
 * The samples hold invented figures. SECURITY.md and CONTRIBUTING are explicit
 * that real financial data never enters the repository, and a sample file is
 * exactly where it would slip in unnoticed.
 */
describe.each(PRESETS.map((preset) => [preset.id, preset] as const))(
  'the %s preset',
  (id, preset) => {
    const sample = readFileSync(join(FIXTURES, `${id}.sample.csv`), 'utf8');

    it('recognises its own sample', () => {
      expect(preset.matches(sample)).toBe(true);
    });

    it('reads it into what the fixture says', async () => {
      // Written on the first run rather than by hand, which is what makes a
      // preset reviewable: somebody drops in a JSON file and a sample, runs the
      // tests, and gets the reading to read through line by line before
      // committing it. After that it is a fixture like any other, and a change
      // to a reader that alters this file has to be explained in the diff.
      await expect(`${JSON.stringify(preset.read(sample), null, 2)}
`).toMatchFileSnapshot(join(FIXTURES, `${id}.expected.json`));
    });

    it('produces transactions that balance', () => {
      // The ledger would refuse them later (ADR-0002). Refused at the last step,
      // a preset with a sign the wrong way round looks like a database problem.
      for (const candidate of preset.read(sample).candidates) {
        const sums = new Map<string, ReturnType<typeof dec>>();
        for (const entry of candidate.entries) {
          sums.set(entry.currency, (sums.get(entry.currency) ?? dec('0')).plus(dec(entry.amount)));
        }

        for (const [currency, sum] of sums) {
          expect(sum.isZero(), `line ${candidate.sourceLines.join(', ')} in ${currency}`).toBe(
            true,
          );
        }
      }
    });

    it('names every account it asks about', () => {
      // A label with no entry in `accounts` reaches the preview as itself, and
      // somebody is asked "which of your accounts is DEFAULT?" with no way to
      // know. Tolerated for a file nobody described; not for a shipped preset.
      //
      // Only the plain accounts. A securities label is named after the cash
      // account it belongs to, and a counterpart is the outside world on every
      // screen - both already read properly with no dictionary entry.
      const asked = preset.read(sample).accounts;

      expect(asked.filter((label) => preset.accounts[label] === undefined)).toEqual([]);
    });
  },
);

describe('a preset file that cannot be trusted', () => {
  const valid = {
    id: 'invented-bank',
    name: 'Invented Bank',
    country: 'FR',
    monogram: 'IB',
    mapping: { columns: { bookedOn: 'date', amount: 'montant' }, currency: 'EUR' },
  };

  const rejects = (change: Record<string, unknown>, because: string | RegExp) => {
    expect(() => parsePresetDefinition({ ...valid, ...change }, 'test.json')).toThrow(because);
  };

  it('takes one that is right', () => {
    const preset = parsePresetDefinition(valid, 'test.json');
    expect(preset.id).toBe('invented-bank');
    expect(preset.mapping?.columns.bookedOn).toBe('date');
  });

  it('refuses a field nobody declared', () => {
    // The failure mode of moving code into data: JSON has no compiler, so a
    // typo is a field that silently does nothing.
    rejects({ acounts: {} }, 'unknown field "acounts"');
  });

  it('refuses an id that is not kebab-case', () => {
    rejects({ id: 'Invented Bank' }, 'not kebab-case');
  });

  it('refuses a country that is not a two-letter code', () => {
    rejects({ country: 'France' }, 'ISO 3166-1');
  });

  it('refuses both a reader and a mapping, and neither', () => {
    rejects({ reader: 'trade-republic' }, 'exactly one');
    rejects({ mapping: undefined }, 'exactly one');
  });

  it('refuses a reader that does not exist', () => {
    rejects({ reader: 'banque-inventee', mapping: undefined }, 'no reader called');
  });

  it('refuses a mapping with no date', () => {
    rejects({ mapping: { columns: { amount: 'montant' } } }, 'names no booking date');
  });

  it('refuses a logo that is not a local path', () => {
    rejects({ logo: 'https://example.invalid/logo.png' }, 'never loads');
  });

  it('refuses an account with no kind', () => {
    rejects(
      { accounts: { ACCOUNT: { nameKey: 'statementAccount' } } },
      'has no kind, or an unknown one',
    );
  });

  it('names the file it is complaining about', () => {
    expect(() => parsePresetDefinition({}, 'fr/invented.json')).toThrow(PresetError);
    expect(() => parsePresetDefinition({}, 'fr/invented.json')).toThrow('fr/invented.json:');
  });
});

describe('a mapping somebody just wrote', () => {
  it('becomes a preset of the same shape as a shipped one', () => {
    // What makes "save this as a preset" a serialisation rather than a
    // translation: the object a contributed file produces and the object the
    // mapping screen produces are one type, built the same way.
    const preset = customPreset({ columns: { bookedOn: 'date', amount: 'montant' } });

    expect(preset.id).toBe(CUSTOM_PRESET_ID);
    expect(preset.accounts['ACCOUNT']?.kind).toBe('cash');
    expect(preset.accounts['EXTERNAL']?.kind).toBe('cash');
    expect(presetById(CUSTOM_PRESET_ID)).toBeUndefined();
  });
});
