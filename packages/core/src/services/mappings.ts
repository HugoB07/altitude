import { and, eq, sql } from 'drizzle-orm';
import { importsMappings, type Database } from '@altitude/db';
import { assertCan, type Actor } from '../auth/policy';
import { parseMapping, type ColumnMapping } from '../import/mapped';
import { assertActorMatchesTenant } from './tenant';

/**
 * Descriptions of bank files, kept so each is written once.
 *
 * The screen builds a `ColumnMapping` for any statement; without somewhere to
 * put it, the same bank is described at every import. That is the difference
 * between the plan's "a mapping screen" and its "remembered" (§8.2, step 4),
 * and it is what the phase's exit criterion means by "without manual
 * intervention".
 */

export interface StoredMapping {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly mapping: ColumnMapping;
  readonly updatedAt: Date;
}

/**
 * The mapping this household has for a file of this shape, if any.
 *
 * The stored JSON goes back through `parseMapping` rather than being cast. A
 * row is input the moment something reads it: it was written by an older
 * version of this code, or by hand, or by a version that allowed a field this
 * one does not. A cast would turn that into a reader indexing every row by
 * `undefined` and reporting a perfectly good file as unreadable.
 *
 * A row that no longer parses is treated as absent, so the screen asks again
 * instead of failing. It is not deleted: what somebody meant is worth keeping
 * even when this version cannot use it.
 */
export async function findMapping(
  tx: Database,
  actor: Actor,
  fingerprint: string,
): Promise<StoredMapping | null> {
  assertCan(actor, 'import:run', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const [row] = await tx
    .select()
    .from(importsMappings)
    .where(eq(importsMappings.fingerprint, fingerprint))
    .limit(1);

  if (row === undefined) return null;

  const mapping = parseMapping(row.mapping);
  if (mapping === null) return null;

  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    mapping,
    updatedAt: row.updatedAt,
  };
}

/** Every mapping this household has, newest first. */
export async function listMappings(tx: Database, actor: Actor): Promise<readonly StoredMapping[]> {
  assertCan(actor, 'import:run', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const rows = await tx
    .select()
    .from(importsMappings)
    .orderBy(sql`${importsMappings.updatedAt} DESC`);

  return [...rows].flatMap((row) => {
    const mapping = parseMapping(row.mapping);
    return mapping === null
      ? []
      : [
          {
            id: row.id,
            name: row.name,
            fingerprint: row.fingerprint,
            mapping,
            updatedAt: row.updatedAt,
          },
        ];
  });
}

/**
 * Keeps a description of a file, or replaces the one already kept for it.
 *
 * Upserted on the fingerprint rather than inserted. A second description of the
 * same shape is a correction - somebody realised the date column was the value
 * date - and keeping both would leave the next import to choose between two
 * answers to one question.
 *
 * Refuses a mapping it cannot parse, rather than storing something that will
 * come back unusable. The screen sends this, so it is input.
 */
export async function rememberMapping(
  tx: Database,
  actor: Actor,
  input: { readonly name: string; readonly fingerprint: string; readonly mapping: unknown },
): Promise<StoredMapping | null> {
  assertCan(actor, 'import:run', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const mapping = parseMapping(input.mapping);
  if (mapping === null) return null;

  const name = input.name.trim() === '' ? input.fingerprint.slice(0, 60) : input.name.trim();

  const [row] = await tx
    .insert(importsMappings)
    .values({
      householdId: actor.householdId,
      name,
      fingerprint: input.fingerprint,
      mapping,
      createdBy: actor.userId,
    })
    .onConflictDoUpdate({
      target: [importsMappings.householdId, importsMappings.fingerprint],
      set: { name, mapping, updatedAt: new Date() },
    })
    .returning();

  if (row === undefined) return null;
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    mapping,
    updatedAt: row.updatedAt,
  };
}

/** Forgets one, so a file can be described from scratch. */
export async function forgetMapping(tx: Database, actor: Actor, id: string): Promise<void> {
  assertCan(actor, 'import:run', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  await tx
    .delete(importsMappings)
    .where(and(eq(importsMappings.id, id), eq(importsMappings.householdId, actor.householdId)));
}
