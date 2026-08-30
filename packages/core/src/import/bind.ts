import type { AccountId } from '@altitude/shared';
import type { Candidate, CandidateEntry, ImportProblem } from './types';

/**
 * A candidate whose account labels have been replaced by real accounts.
 *
 * The reader speaks the exporter's vocabulary - "PEA", "DEFAULT", "EXTERNAL" -
 * because a file cannot know account ids. Turning those into accounts is a
 * decision a person makes once per import, and everything after this point
 * works with accounts rather than labels.
 */
export interface BoundEntry extends Omit<CandidateEntry, 'account'> {
  readonly accountId: AccountId;
  /** Kept for the preview, which shows what the file called it. */
  readonly label: string;
}

export interface BoundCandidate extends Omit<Candidate, 'entries'> {
  readonly entries: readonly BoundEntry[];
}

/** What the preview collected: one account per label the file mentioned. */
export type AccountBinding = Readonly<Record<string, AccountId | undefined>>;

export interface BindResult {
  readonly bound: readonly BoundCandidate[];
  /** Candidates that could not be bound, and why. Never silently dropped. */
  readonly problems: readonly ImportProblem[];
}

/**
 * Replaces every label with the account chosen for it.
 *
 * A candidate with an unbound label is set aside rather than guessed at or
 * dropped. Guessing puts money in an account nobody chose; dropping loses a
 * transaction without saying so, which is the failure a person only discovers
 * when a balance disagrees with their bank months later.
 *
 * Pure: it reads no database and writes nothing, so the preview can show the
 * effect of a change to the mapping without touching anything.
 */
export function bindAccounts(
  candidates: readonly Candidate[],
  binding: AccountBinding,
): BindResult {
  const bound: BoundCandidate[] = [];
  const problems: ImportProblem[] = [];

  for (const candidate of candidates) {
    const missing = candidate.entries
      .map((entry) => entry.account)
      .filter((label) => binding[label] === undefined);

    if (missing.length > 0) {
      problems.push({
        line: candidate.sourceLines[0] ?? 0,
        reason: `No account chosen for ${[...new Set(missing)].join(', ')}`,
      });
      continue;
    }

    bound.push({
      ...candidate,
      entries: candidate.entries.map((entry) => {
        const { account, ...rest } = entry;
        return { ...rest, accountId: binding[account]!, label: account };
      }),
    });
  }

  return { bound, problems };
}
