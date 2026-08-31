import { eq, inArray, sql } from 'drizzle-orm';
import { imports, instruments, type Database } from '@altitude/db';
import {
  Money,
  dec,
  instrumentId,
  type ImportId,
  type LedgerDate,
  type TransactionId,
} from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
import type { BoundCandidate } from '../import/bind';
import type { CandidateInstrument } from '../import/types';
import type { TransactionInput } from '../ledger/types';
import { postTransaction, reverseTransactionById } from './transactions';
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
       -- Cancelled transactions are not matches. One would report a candidate
       -- as "already imported" when what is in the ledger is a movement that
       -- was undone, which is the opposite of the truth - and it would block
       -- re-importing a file after rolling it back.
       AND t.reversed_at IS NULL
       -- Nor are the reversals themselves: a candidate looks exactly like the
       -- opposite of itself in every respect but sign, and the shape below is
       -- sign-sensitive only by luck.
       AND t.reverses_id IS NULL
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

export class ImportNotFoundError extends Error {
  readonly code = 'IMPORT_NOT_FOUND';
  constructor(id: ImportId) {
    // Deliberately the same message whether the run belongs to another
    // household or does not exist, like every other lookup here.
    super(`No import ${id} in this household.`);
    this.name = 'ImportNotFoundError';
  }
}

export class ImportAlreadyRolledBackError extends Error {
  readonly code = 'IMPORT_ALREADY_ROLLED_BACK';
  constructor(id: ImportId) {
    super(`Import ${id} has already been undone.`);
    this.name = 'ImportAlreadyRolledBackError';
  }
}

export interface RollbackResult {
  readonly importId: ImportId;
  /** How many of the run's transactions were reversed by this call. */
  readonly reversed: number;
  /** How many were already reversed by hand and were left alone. */
  readonly skipped: number;
}

/**
 * Undoes a whole import by reversing every transaction it made.
 *
 * Nothing is deleted. A reversal is the opposite transaction posted beside the
 * original (ADR-0002), so the file's contents and the decision to undo them are
 * both still in the ledger afterwards. That is the point: "N created, N
 * skipped, undoable in one click" is only trustworthy if the undo is itself
 * something you can look at.
 *
 * Everything or nothing: the caller wraps this in one unit of work, so a run
 * half undone cannot exist. Half of a reversal is worse than none, because the
 * balances then match neither the file nor the statement.
 *
 * A transaction somebody already reversed by hand is skipped rather than
 * refused. Reversing a reversal would post the original amount a second time,
 * quietly doubling it - and refusing the whole run because of one row would
 * leave a person with no way to undo the rest.
 *
 * Dated today rather than on the original's day. A correction happened when it
 * happened; backdating one silently rewrites what a past month looked like,
 * which is the property ADR-0002 exists to keep.
 */
export async function rollbackImport(
  tx: Database,
  actor: Actor,
  input: {
    readonly importId: ImportId;
    readonly on: LedgerDate;
    /** One id per transaction to reverse, minted by the caller. */
    readonly reversalIds: readonly TransactionId[];
  },
): Promise<RollbackResult> {
  assertCan(actor, 'import:rollback', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const [batch] = await tx
    .select({ id: imports.id, rolledBackAt: imports.rolledBackAt })
    .from(imports)
    .where(eq(imports.id, input.importId))
    .limit(1);

  if (batch === undefined) throw new ImportNotFoundError(input.importId);
  if (batch.rolledBackAt !== null) throw new ImportAlreadyRolledBackError(input.importId);

  // Oldest first, so the reversals read in the order the originals were made.
  const rows = await tx.execute<{ id: string; reversed_by_id: string | null }>(sql`
    SELECT t.id,
           (SELECT r.id FROM transactions r WHERE r.reverses_id = t.id LIMIT 1) AS reversed_by_id
      FROM transactions t
     WHERE t.import_id = ${input.importId}::uuid
     ORDER BY t.booked_on, t.id
  `);

  const standing = [...rows].filter((row) => row.reversed_by_id === null);
  if (standing.length > input.reversalIds.length) {
    throw new Error(
      `Rolling back ${input.importId} needs ${String(standing.length)} ids, given ${String(input.reversalIds.length)}.`,
    );
  }

  for (const [index, row] of standing.entries()) {
    await reverseTransactionById(
      tx,
      actor,
      row.id as TransactionId,
      input.reversalIds[index]!,
      input.on,
    );
  }

  await tx
    .update(imports)
    .set({ rolledBackAt: new Date(), rolledBackBy: actor.userId })
    .where(eq(imports.id, input.importId));

  return {
    importId: input.importId,
    reversed: standing.length,
    skipped: [...rows].length - standing.length,
  };
}

export interface ImportRun {
  readonly id: ImportId;
  readonly source: string;
  readonly filename: string;
  readonly createdAt: Date;
  /** How many transactions the run made, reversed ones included. */
  readonly transactions: number;
  readonly rolledBackAt: Date | null;
}

/**
 * The runs this household has made, newest first.
 *
 * The count comes from the transactions rather than from a column on the batch:
 * a stored count is a second copy of a fact the ledger already holds, free to
 * disagree with it the first time anything else touches a row.
 */
export async function listImports(tx: Database, actor: Actor): Promise<readonly ImportRun[]> {
  assertCan(actor, 'import:run', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  // Typed as they arrive, not as they are wanted. `tx.execute` runs raw SQL and
  // hands timestamps back as strings; annotating them `Date` compiled, and then
  // `createdAt.toISOString()` threw at the first render of the screen. The
  // conversion belongs here, where the shape is known.
  const rows = await tx.execute<{
    id: string;
    source: string;
    filename: string;
    created_at: string;
    transactions: string;
    rolled_back_at: string | null;
  }>(sql`
    SELECT i.id,
           i.source,
           i.filename,
           i.created_at,
           i.rolled_back_at,
           (SELECT count(*) FROM transactions t WHERE t.import_id = i.id) AS transactions
      FROM imports i
     ORDER BY i.created_at DESC
  `);

  return [...rows].map((row) => ({
    id: row.id as ImportId,
    source: row.source,
    filename: row.filename,
    createdAt: new Date(row.created_at),
    transactions: Number(row.transactions),
    rolledBackAt: row.rolled_back_at === null ? null : new Date(row.rolled_back_at),
  }));
}
