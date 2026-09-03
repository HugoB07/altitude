import { describe, expect, it } from 'vitest';
import { parsePresetDefinition } from '@altitude/core';
import { presetFileDraft } from '../src/lib/preset-draft';

/**
 * What the contribute button writes has to be what the loader accepts.
 *
 * The two live on opposite sides of the bundler and can never import each
 * other: the loader reaches the readers, which reach the database driver, so
 * the screen builds the file by hand. This is the only thing joining them, and
 * without it the failure surfaces on whoever reviews the pull request rather
 * than on the person who could still fix it.
 */
const MAPPING = {
  columns: { bookedOn: 'Date', description: 'Libelle', amount: 'Montant', balance: 'Solde' },
  currency: 'EUR',
  dateOrder: 'dmy',
};

describe('a mapping offered back as a preset', () => {
  it('writes a file the loader takes', () => {
    const file = presetFileDraft({ name: 'Banque Inventee', country: 'fr', mapping: MAPPING });

    expect(file).not.toBeNull();
    const preset = parsePresetDefinition(JSON.parse(file!.json), file!.path);

    expect(preset.id).toBe('banque-inventee');
    expect(preset.country).toBe('FR');
    expect(preset.mapping?.columns.bookedOn).toBe('Date');
    expect(preset.mapping?.columns.balance).toBe('Solde');
  });

  it('puts it where the loader looks', () => {
    const file = presetFileDraft({ name: 'Banque Inventee', country: 'FR', mapping: MAPPING });

    expect(file?.path).toBe('packages/core/src/import/presets/fr/banque-inventee.json');
  });

  it('derives an id from a name with accents and punctuation', () => {
    const file = presetFileDraft({ name: "Caisse d'Épargne", country: 'FR', mapping: MAPPING });

    // Kebab-case with no accents, because the loader refuses anything else -
    // and because the id is a filename on somebody's Windows machine.
    expect(file?.id).toBe('caisse-d-epargne');
    expect(() => parsePresetDefinition(JSON.parse(file!.json), 'x')).not.toThrow();
  });

  it('takes initials for a monogram, or the first two letters of one word', () => {
    const two = presetFileDraft({ name: 'Crédit Agricole', country: 'FR', mapping: MAPPING });
    const one = presetFileDraft({ name: 'Fortuneo', country: 'FR', mapping: MAPPING });

    expect(JSON.parse(two!.json).monogram).toBe('CA');
    expect(JSON.parse(one!.json).monogram).toBe('FO');
  });

  it('writes nothing without a name or a country code', () => {
    expect(presetFileDraft({ name: '  ', country: 'FR', mapping: MAPPING })).toBeNull();
    expect(presetFileDraft({ name: 'Banque', country: '', mapping: MAPPING })).toBeNull();
    expect(presetFileDraft({ name: 'Banque', country: 'France', mapping: MAPPING })).toBeNull();
  });

  it('refuses to write a mapping the loader would reject', () => {
    // A file with no booking date column cannot be a preset, and the loader is
    // where that is decided - the screen does not get a second opinion.
    const file = presetFileDraft({
      name: 'Banque Inventee',
      country: 'FR',
      mapping: { columns: { amount: 'Montant' } },
    });

    expect(() => parsePresetDefinition(JSON.parse(file!.json), file!.path)).toThrow(
      'names no booking date',
    );
  });
});
