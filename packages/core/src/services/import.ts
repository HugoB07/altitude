import { sql } from 'drizzle-orm';
import type { Database } from '@altitude/db';
import { dec, type TransactionId } from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
import type { BoundCandidate } from '../import/bind';
import { assertActorMatchesTenant } from './tenant';

/**
 * What the ledger already knows about a candidate.
 *
 * Three answers rather than two, because the difference between them is the
 * whole design. `certain` means the provider's own identifier is already in the
 * ledger and there is nothing to decide. `probable` means it looks the same and
 * only a person can say - two transfers of the same amount on one day are a
 * common and entirely real thing.
 *
 * The asymmetry is why `probable` is not treated as `certain`: creating a
 * duplicate is visible and reversible, while dropping a real movement is
 * neither. A balance that is quietly wrong is worse than a row somebody has to
 * delete.
 */
export type Verdict =
  | { readonly kind: 'new' }
  | { readonly kind: 'certain'; readonly existing: TransactionId }
  | { readonly kind: 'probable'; readonly existing: TransactionId };

export interface DuplicateReport {
  /** One verdict per candidate, in the order given. */
  readonly verdicts: readonly Verdict[];
}

interface Existing {
  readonly id: TransactionId;
  readonly bookedOn: string;
  readonly externalId: string | null;
  /** `accountId:amount`, sorted, so two entry lists compare as one string. */
  readonly shape: string;
  taken: boolean;
}

/**
 * Compares a batch of candidates against what the ledger already holds.
 *
 * One query for the whole batch rather than one per candidate: an import of a
 * thousand rows would otherwise be a thousand round trips, and the window it
 * needs - the dates the file covers - is known up front.
 *
 * No `dedupe_hash` is computed. The column exists for the day a ledger is large
 * enough that comparing shapes in memory stops being free, and until then a
 * hash is a second representation of the same fact that can disagree with the
 * first.
 *
 * The query names no household. Row-level security does the filtering, so a
 * candidate can never be matched against another household's transaction.
 */
export async function findDuplicates(
  tx: Database,
  actor: Actor,
  candidates: readonly BoundCandidate[],
): Promise<DuplicateReport> {
  assertCan(actor, 'transaction:read', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  if (candidates.length === 0) return { verdicts: [] };

  const dates = candidates.map((candidate) => candidate.bookedOn).sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;

  const rows = await tx.execute<{
    id: string;
    booked_on: string;
    external_id: string | null;
    shape: string;
  }>(sql`
    SELECT t.id,
           t.booked_on::text AS booked_on,
           t.external_id,
           COALESCE(
             -- trim_scale, not a bare cast. The column is numeric(28,10), so
             -- ::text renders -39.82 as "-39.8200000000" while Decimal writes
             -- "-39.82" - and the two would never compare equal, leaving
             -- deduplication finding nothing at all and saying nothing about it.
             (SELECT string_agg(
                       e.account_id::text || ':' || trim_scale(e.amount)::text, '|' ORDER BY
                       e.account_id::text || ':' || trim_scale(e.amount)::text)
                FROM entries e
               WHERE e.transaction_id = t.id),
             ''
           ) AS shape
      FROM transactions t
     WHERE t.booked_on BETWEEN ${from}::date AND ${to}::date
  `);

  const existing: Existing[] = [...rows].map((row) => ({
    id: row.id as TransactionId,
    bookedOn: row.booked_on,
    externalId: row.external_id,
    shape: row.shape,
    taken: false,
  }));

  const byExternalId = new Map<string, Existing>();
  for (const row of existing) {
    if (row.externalId !== null) byExternalId.set(row.externalId, row);
  }

  const verdicts: Verdict[] = candidates.map((candidate) => {
    if (candidate.externalId !== undefined) {
      const match = byExternalId.get(candidate.externalId);
      // An identifier match needs no consuming: the column is unique per
      // household, so one candidate cannot match two rows or two candidates the
      // same row.
      if (match !== undefined) return { kind: 'certain', existing: match.id };
      return { kind: 'new' };
    }

    const shape = shapeOf(candidate);
    // Consumed once matched. Two identical transfers in the file against one in
    // the ledger means one is already there and one is genuinely new - marking
    // both as duplicates would lose a real movement.
    const match = existing.find(
      (row) => !row.taken && row.bookedOn === candidate.bookedOn && row.shape === shape,
    );
    if (match === undefined) return { kind: 'new' };

    match.taken = true;
    return { kind: 'probable', existing: match.id };
  });

  return { verdicts };
}

/**
 * The accounts and amounts a candidate moves, as one comparable string.
 *
 * Normalised through Decimal and sorted, so `-39.820000` on two entries listed
 * in either order produces the same shape as `-39.82` does. The description is
 * deliberately not part of it: two identical movements labelled differently are
 * still worth flagging, and a bank that changes its wording between exports
 * would otherwise duplicate a person's entire history.
 */
function shapeOf(candidate: BoundCandidate): string {
  return candidate.entries
    .map((entry) => `${entry.accountId}:${dec(entry.amount).toFixed()}`)
    .sort()
    .join('|');
}
