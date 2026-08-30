import { looksLikeTradeRepublic, readTradeRepublic, type ImportReading } from '@altitude/core';

/**
 * The banks Altitude already knows how to read.
 *
 * Two kinds will eventually live here. A coded preset, like the one below, is a
 * module: it exists because an export is not one row per transaction and no
 * arrangement of column names could express it. A declarative preset is a
 * mapping - this column is the date, that one the amount - and is what the
 * custom path produces, which means adding one is a JSON file rather than
 * TypeScript. Most banks will be declarative; brokers will not.
 *
 * The distinction is invisible on screen. It only decides who can add a bank.
 */
export interface Preset {
  readonly id: string;
  readonly name: string;
  /**
   * Two letters, drawn as a tile when there is no logo file.
   *
   * A bank's logo is a trademark, and bundling one in an AGPL repository is a
   * licensing question rather than a design one. A monogram is neither, works
   * offline like everything else here, and leaves `logo` free for the day a
   * particular mark is cleared to ship.
   */
  readonly monogram: string;
  /** A file under `public/banks/`. Never a remote URL: an offline instance must render. */
  readonly logo?: string;
  readonly read: (text: string) => ImportReading;
  /** Whether a file looks like this preset's, used to warn before reading it wrongly. */
  readonly matches: (text: string) => boolean;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'trade-republic',
    name: 'Trade Republic',
    monogram: 'TR',
    logo: '/banks/trade-republic.jpeg',
    read: readTradeRepublic,
    matches: looksLikeTradeRepublic,
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
