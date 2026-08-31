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
  /**
   * What the exporter's own codes mean, in words.
   *
   * A reader speaks the file's vocabulary, and the file's vocabulary is
   * `DEFAULT` and `PEA`. That is fine inside the code and useless on screen:
   * somebody was asked "which of your accounts is DEFAULT?" and had no way to
   * know. The preset knows, because knowing this bank is what a preset is.
   *
   * A message key, not a name, so the answer is in the reader's language. A
   * label that is not listed falls back to itself, which is no worse than
   * before and never blocks a file with a code nobody has seen yet.
   */
  readonly accounts?: Readonly<Record<string, PresetAccount>>;
  /** Named on accounts this import creates, so a person can see where they came from. */
  readonly institution?: string;
}

export interface PresetAccount {
  /** A key under the `import.account` namespace. */
  readonly nameKey: string;
  /** The kind to create it as, when nobody has an account for it yet. */
  readonly kind: 'cash' | 'securities' | 'savings';
  /**
   * Whether this account holds its cash and its shares together.
   *
   * A reader splits every trade into a cash side and a securities side, because
   * for most accounts those are two places: money leaves the current account and
   * shares arrive in the brokerage account beside it. A French PEA is not like
   * that. It is one account with cash and holdings inside it, and asking a
   * person to name a separate "PEA securities" account asks them to invent one.
   *
   * So it is a fact about a bank's own product, which is why it lives in a
   * preset. Trade Republic keeps a current account and a CTO apart and keeps a
   * PEA whole; another bank splits them all, and a third splits none.
   */
  readonly holdsSharesToo?: boolean;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'trade-republic',
    name: 'Trade Republic',
    monogram: 'TR',
    logo: '/banks/trade-republic.jpeg',
    read: readTradeRepublic,
    matches: looksLikeTradeRepublic,
    institution: 'Trade Republic',
    accounts: {
      // The cash of a Trade Republic account is the current account, and the
      // shares bought with it sit in the CTO next to it: two accounts.
      DEFAULT: { nameKey: 'tradeRepublicCurrent', kind: 'cash' },
      'DEFAULT:SECURITIES': { nameKey: 'tradeRepublicCto', kind: 'securities' },
      // A PEA is one account holding both. Money is transferred into it from
      // the current account, and inside it cash becomes shares.
      PEA: { nameKey: 'tradeRepublicPea', kind: 'securities', holdsSharesToo: true },
    },
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
