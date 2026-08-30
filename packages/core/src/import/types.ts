import type { LedgerDate } from '@altitude/shared';

/**
 * A transaction a file proposes, before anything is written.
 *
 * Deliberately not a `TransactionInput`. That type names real account ids, and a
 * file cannot know them - it says "PEA" or "DEFAULT", which are labels in the
 * exporter's vocabulary. Binding those labels to accounts is a decision a person
 * makes on the preview screen, and keeping it out of the reader is what lets the
 * reader be a pure function over text.
 */
/**
 * What a reader decided one line of a transaction is.
 *
 * A token rather than a sentence, because the sentence has to be written in the
 * reader's language and `packages/core` has no idea what that is. Prose here
 * meant "Gross" and "Withholding tax" reaching a French ledger in English and
 * staying there: the memo is persisted, so the mistake is permanent per row.
 *
 * The web layer renders these, and writes the rendered text into `memo` at
 * import time. Distinct from `memo` itself, which carries text that came from
 * the file and is nobody's to translate.
 */
export type EntryRole = 'gross' | 'withholdingTax' | 'netCredited';

export interface CandidateEntry {
  /**
   * The source's own name for the account this line moves.
   *
   * Two labels are conventions rather than data from the file: `EXTERNAL` is
   * the counterpart for money arriving from or leaving the outside world, which
   * double entry requires and a bank statement never names. Everything else is
   * whatever the exporter wrote.
   */
  readonly account: string;
  /** An exact decimal string. Never a number, at any point (ADR-0006). */
  readonly amount: string;
  readonly currency: string;
  readonly quantity?: string;
  readonly unitPrice?: string;
  readonly instrument?: CandidateInstrument;
  /** What this line is, for the screen to name. See `EntryRole`. */
  readonly role?: EntryRole;
  /** Text the file itself carried, such as a payment reference. Never translated. */
  readonly memo?: string;
}

/** An instrument the file mentions, to be found or created at write time. */
export interface CandidateInstrument {
  readonly isin?: string;
  readonly symbol?: string;
  readonly name: string;
  readonly currency: string;
  readonly kind: string;
}

export interface Candidate {
  /**
   * The provider's own identifier for this transaction, where it has one.
   *
   * This is what makes re-importing the same file add nothing: it lands in
   * `transactions.external_id`, which is unique per household. Without it,
   * deduplication has to guess from date, amount and label, and two identical
   * transfers on one day are indistinguishable from one imported twice.
   */
  readonly externalId?: string;
  readonly bookedOn: LedgerDate;
  readonly kind: string;
  readonly description?: string;
  readonly entries: readonly CandidateEntry[];
  /**
   * The lines of the file this came from, 1-based and counting the header.
   *
   * Carried so the preview can point at them. One candidate often comes from
   * two rows - a broker that splits a transfer across the sending and receiving
   * account - and being able to say which is the difference between "something
   * is wrong with your file" and "look at line 14".
   */
  readonly sourceLines: readonly number[];
}

/**
 * A row the reader could not turn into anything.
 *
 * Collected rather than thrown. A file of four hundred rows with one bad date
 * should import three hundred and ninety-nine and say which one it could not
 * read - stopping at the first problem makes a person fix them one run at a
 * time, and skipping them silently is worse than either.
 */
export interface ImportProblem {
  readonly line: number;
  readonly reason: string;
  /** The raw row, so the preview can show what it choked on. */
  readonly row?: Readonly<Record<string, string>>;
}

export interface ImportReading {
  readonly candidates: readonly Candidate[];
  /**
   * Every distinct account label the file mentions, in the order first seen.
   *
   * This is what the preview screen asks about: one file routinely covers
   * several accounts, and only a person knows which of theirs each one is.
   */
  readonly accounts: readonly string[];
  /**
   * Labels for the account that holds the shares, not the cash beside them.
   *
   * A broker statement names one account and means two: buying moves cash out
   * of the cash account and a holding into the securities account, and both
   * sides carry the same name in the file. Booking them to one account netted
   * every purchase to nothing and left the shares nowhere.
   *
   * Bound once for the whole file, like `accounts` - a securities account does
   * not change between transactions the way a counterpart does.
   */
  readonly securities: readonly string[];
  /**
   * Labels that stand for the outside world rather than for an account.
   *
   * Kept apart from `accounts` because the two are answered differently, and
   * treating them alike was a real mistake on the preview screen. `PEA` is one
   * account for the whole file. `EXTERNAL` is not an account at all: it is
   * wherever the money came from, and that is a salary on one line and a
   * transfer from another bank of your own on the next. One answer for the file
   * would file both under the same account and quietly lose the difference.
   *
   * So a counterpart gets a default that a person can override transaction by
   * transaction, and a plain account does not.
   */
  readonly counterparts: readonly string[];
  readonly problems: readonly ImportProblem[];
}
