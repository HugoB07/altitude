import { inArray, sql } from 'drizzle-orm';
import { imports, instruments, type Database } from '@altitude/db';
import { Money, dec, instrumentId, type ImportId, type TransactionId } from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
import type { BoundCandidate } from '../import/bind';
import type { CandidateInstrument } from '../import/types';
import type { TransactionInput } from '../ledger/types';
import { postTransaction } from './transactions';
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

export interface CommitInput {
  readonly importId: ImportId;
  readonly source: string;
  readonly filename: string;
  readonly candidates: readonly BoundCandidate[];
  /** One id per candidate, minted by the caller: the domain builds before anything is written. */
  readonly transactionIds: readonly TransactionId[];
}

export interface CommitResult {
  readonly importId: ImportId;
  readonly written: number;
  readonly instrumentsCreated: number;
}

/**
 * Writes a reviewed import.
 *
 * Everything or nothing: the caller wraps this in one unit of work, so a file
 * that fails halfway leaves no half-imported month behind. That matters more
 * here than anywhere else in the application - a partial import is invisible,
 * and the person who runs it again gets duplicates of the part that succeeded.
 *
 * Takes only what a person approved. Deduplication produced verdicts and the
 * preview turned them into a decision; nothing here reconsiders it, because a
 * service that filtered again would be a second opinion able to disagree with
 * the one shown on screen.
 *
 * Every transaction goes through `postTransaction`, which validates the balance
 * and checks the actor, rather than being inserted directly. An import is not a
 * privileged path into the ledger: a file cannot write something a person could
 * not have typed.
 */
export async function commitImport(
  tx: Database,
  actor: Actor,
  input: CommitInput,
): Promise<CommitResult> {
  assertCan(actor, 'import:run', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  await tx.insert(imports).values({
    id: input.importId,
    householdId: actor.householdId,
    source: input.source,
    filename: input.filename,
    createdBy: actor.userId,
  });

  const resolved = await resolveInstruments(tx, input.candidates);

  for (const [index, candidate] of input.candidates.entries()) {
    const id = input.transactionIds[index];
    if (id === undefined) throw new Error(`No id given for candidate ${String(index)}`);

    await postTransaction(tx, actor, {
      id,
      bookedOn: candidate.bookedOn,
      kind: candidate.kind as TransactionInput['kind'],
      source: 'import',
      importId: input.importId,
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
      ...(candidate.externalId === undefined ? {} : { externalId: candidate.externalId }),
      entries: candidate.entries.map((entry) => ({
        accountId: entry.accountId,
        amount: Money.of(entry.amount, entry.currency),
        ...(entry.memo === undefined ? {} : { memo: entry.memo }),
        ...(entry.quantity === undefined ? {} : { quantity: dec(entry.quantity) }),
        ...(entry.unitPrice === undefined
          ? {}
          : { unitPrice: Money.of(entry.unitPrice, entry.currency) }),
        ...(entry.instrument === undefined
          ? {}
          : {
              instrumentId: instrumentId(resolved.byKey.get(instrumentKey(entry.instrument))!),
            }),
      })),
    });
  }

  return {
    importId: input.importId,
    written: input.candidates.length,
    instrumentsCreated: resolved.created,
  };
}

/**
 * Finds every instrument the batch mentions, creating the ones that are new.
 *
 * Matched on ISIN where there is one, because that is what identifies an
 * instrument to the world. A holding with no ISIN falls back to its name, which
 * is weaker - two brokers spell the same fund differently - and is why an
 * import of unlisted holdings will eventually need a person to say "these two
 * are the same thing".
 */
async function resolveInstruments(
  tx: Database,
  candidates: readonly BoundCandidate[],
): Promise<{ byKey: Map<string, string>; created: number }> {
  const wanted = new Map<string, CandidateInstrument>();
  for (const candidate of candidates) {
    for (const entry of candidate.entries) {
      if (entry.instrument !== undefined)
        wanted.set(instrumentKey(entry.instrument), entry.instrument);
    }
  }

  const byKey = new Map<string, string>();
  if (wanted.size === 0) return { byKey, created: 0 };

  const isins = [...wanted.values()].map((i) => i.isin).filter((i) => i !== undefined);
  const existing =
    isins.length === 0
      ? []
      : await tx
          .select({ id: instruments.id, isin: instruments.isin, name: instruments.name })
          .from(instruments)
          .where(inArray(instruments.isin, isins));

  for (const row of existing) {
    if (row.isin !== null) byKey.set(`isin:${row.isin}`, row.id);
  }

  let created = 0;
  for (const [key, instrument] of wanted) {
    if (byKey.has(key)) continue;
    const [row] = await tx
      .insert(instruments)
      .values({
        ...(instrument.isin === undefined ? {} : { isin: instrument.isin }),
        ...(instrument.symbol === undefined ? {} : { symbol: instrument.symbol }),
        name: instrument.name,
        currency: instrument.currency,
        kind: instrument.kind,
      })
      .returning({ id: instruments.id });
    byKey.set(key, row!.id);
    created += 1;
  }

  return { byKey, created };
}

/** ISIN when there is one, name otherwise. See `resolveInstruments`. */
function instrumentKey(instrument: CandidateInstrument): string {
  return instrument.isin === undefined
    ? `name:${instrument.name.toLowerCase()}`
    : `isin:${instrument.isin}`;
}
