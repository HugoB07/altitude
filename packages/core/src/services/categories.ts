import { asc, eq, sql } from 'drizzle-orm';
import { categories, categorisationRules, type Database } from '@altitude/db';
import type { CategoryId } from '@altitude/shared';
import { assertCan, type Actor } from '../auth/policy';
import { categorise, parseConditions, type CategorisationRule } from '../categories/rules';
import { assertActorMatchesTenant } from './tenant';

/**
 * Categories, the rules that decide them, and applying those rules.
 *
 * Step 7 of the import pipeline (plan §8.2), and the only one that also runs
 * outside an import: rules change, and somebody who writes a better one wants
 * it applied to what is already there.
 */

export interface Category {
  readonly id: CategoryId;
  readonly name: string;
}

export interface StoredRule extends CategorisationRule {
  readonly categoryName: string;
}

export async function listCategories(tx: Database, actor: Actor): Promise<Category[]> {
  assertCan(actor, 'category:read', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const rows = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .orderBy(asc(categories.name));

  return rows.map((row) => ({ id: row.id as CategoryId, name: row.name }));
}

export async function createCategory(
  tx: Database,
  actor: Actor,
  input: { readonly id: CategoryId; readonly name: string },
): Promise<Category | null> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const name = input.name.trim();
  if (name === '') return null;

  // The name is unique per household, case-folded. A second attempt at one
  // that exists is somebody typing what they already have, not an error worth
  // a message: they get the category they asked for.
  const [made] = await tx
    .insert(categories)
    .values({ id: input.id, householdId: actor.householdId, name, createdBy: actor.userId })
    .onConflictDoNothing()
    .returning({ id: categories.id, name: categories.name });

  if (made !== undefined) return { id: made.id as CategoryId, name: made.name };

  const [existing] = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(sql`lower(${categories.name}) = lower(${name})`)
    .limit(1);

  return existing === undefined ? null : { id: existing.id as CategoryId, name: existing.name };
}

/**
 * Removes a category.
 *
 * The database says what happens to what pointed at it: entries fall back to
 * having none (`ON DELETE SET NULL`), and rules that filed into it go with it
 * (`ON DELETE CASCADE`). A rule whose category no longer exists would be a
 * rule that cannot be applied, which is worse than one less rule.
 *
 * Nothing in the ledger moves. A category is what a movement was for, not the
 * movement.
 */
export async function deleteCategory(tx: Database, actor: Actor, id: string): Promise<void> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  // Row-level security makes another household's id match nothing.
  await tx.delete(categories).where(eq(categories.id, id));
}

/**
 * Every rule this household has, in the order the engine reads them.
 *
 * A row whose conditions this version cannot parse is left out rather than
 * cast. A rule built from `undefined` fields would take every entry it was
 * offered, which is the one failure a categoriser must not have - and the row
 * itself is kept, because it is somebody's intent.
 */
export async function listRules(tx: Database, actor: Actor): Promise<StoredRule[]> {
  assertCan(actor, 'category:read', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const rows = await tx
    .select({
      id: categorisationRules.id,
      name: categorisationRules.name,
      priority: categorisationRules.priority,
      conditions: categorisationRules.conditions,
      categoryId: categorisationRules.categoryId,
      stopOnMatch: categorisationRules.stopOnMatch,
      categoryName: categories.name,
    })
    .from(categorisationRules)
    .innerJoin(categories, eq(categories.id, categorisationRules.categoryId))
    .orderBy(asc(categorisationRules.priority), asc(categorisationRules.id));

  return rows.flatMap((row) => {
    const conditions = parseConditions(row.conditions);
    if (conditions === null) return [];
    return [
      {
        id: row.id,
        name: row.name,
        priority: row.priority,
        conditions,
        categoryId: row.categoryId,
        stopOnMatch: row.stopOnMatch,
        categoryName: row.categoryName,
      },
    ];
  });
}

export interface NewRule {
  readonly id: string;
  readonly name: string;
  readonly priority?: number;
  readonly conditions: unknown;
  readonly categoryId: CategoryId;
  readonly stopOnMatch?: boolean;
}

/** Refuses a rule it could not read back, rather than storing one that does nothing. */
export async function createRule(
  tx: Database,
  actor: Actor,
  input: NewRule,
): Promise<StoredRule | null> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const conditions = parseConditions(input.conditions);
  const name = input.name.trim();
  if (conditions === null || name === '') return null;

  const priority = input.priority ?? 100;
  const stopOnMatch = input.stopOnMatch ?? true;

  const [made] = await tx
    .insert(categorisationRules)
    .values({
      id: input.id,
      householdId: actor.householdId,
      name,
      priority,
      conditions,
      categoryId: input.categoryId,
      stopOnMatch,
      createdBy: actor.userId,
    })
    .returning({ id: categorisationRules.id });

  if (made === undefined) return null;

  const [category] = await tx
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.id, input.categoryId))
    .limit(1);

  return {
    id: made.id,
    name,
    priority,
    conditions,
    categoryId: input.categoryId,
    stopOnMatch,
    categoryName: category?.name ?? '',
  };
}

export async function deleteRule(tx: Database, actor: Actor, id: string): Promise<void> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  // Row-level security makes another household's id match nothing.
  await tx.delete(categorisationRules).where(eq(categorisationRules.id, id));
}

/**
 * Files a transaction under a category by hand, or takes it out of one.
 *
 * Only the household's own side of it: the equity counterpart is the edge of
 * the household, and categorising it would count the same movement twice.
 *
 * `categorised_by` is cleared, which is the point rather than a detail. It is
 * what tells a later pass that a person decided this one, and a pass leaves
 * those alone (plan §8.6 - the user stays in control, nothing happens
 * invisibly).
 */
export async function setTransactionCategory(
  tx: Database,
  actor: Actor,
  input: { readonly transactionId: string; readonly categoryId: CategoryId | null },
): Promise<number> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const done = await tx.execute(sql`
    UPDATE entries e
       SET category_id = ${input.categoryId}::uuid,
           categorised_by = NULL
      FROM accounts a
     WHERE a.id = e.account_id
       AND e.transaction_id = ${input.transactionId}::uuid
       AND a.classification <> 'equity'
    RETURNING e.id
  `);

  return done.length;
}

export interface ApplyResult {
  /** Entries whose category changed, or would change. */
  readonly changed: number;
  /** What they would become, by category name, largest first. */
  readonly byCategory: readonly { readonly name: string; readonly count: number }[];
}

/**
 * Runs the rules over entries already in the ledger.
 *
 * Never over an entry a person categorised. `categorised_by` is what separates
 * the two: a pass takes entries no rule has claimed, and entries a rule
 * claimed before - so editing a rule changes what it decided, and nobody's own
 * answer is quietly replaced.
 *
 * `preview` is the plan's requirement that re-applying be a deliberate act
 * with a count in front of it (§8.6). Same code path, so what it reports is
 * what would happen rather than a second opinion about it.
 */
export async function applyRules(
  tx: Database,
  actor: Actor,
  options: { readonly preview?: boolean; readonly importId?: string } = {},
): Promise<ApplyResult> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const rules = await listRules(tx, actor);
  if (rules.length === 0) return { changed: 0, byCategory: [] };

  const rows = await tx.execute<{
    id: string;
    description: string | null;
    amount: string;
    account_id: string;
    account_class: string;
    category_id: string | null;
  }>(sql`
    SELECT e.id::text AS id,
           t.description,
           trim_scale(e.amount)::text AS amount,
           e.account_id::text AS account_id,
           a.classification AS account_class,
           e.category_id::text AS category_id
      FROM entries e
      JOIN transactions t ON t.id = e.transaction_id
      JOIN accounts a ON a.id = e.account_id
     -- Untouched, or last touched by a rule. What a person chose stays.
     WHERE (e.category_id IS NULL OR e.categorised_by IS NOT NULL)
       -- Reversals take part, and so do the transactions they cancel.
       --
       -- Excluding them was borrowed from the duplicate finder, where a cancelled
       -- movement genuinely is not a match. Here it is the opposite: a
       -- purchase filed under groceries and its reversal left uncategorised
       -- makes the groceries total wrong by the amount of a thing that did not
       -- happen. Both sides carry the category, and they cancel.
       -- Narrowed to one run when this is step 7 of an import rather than a
       -- pass over the ledger: reading every entry a household has, to write
       -- twelve, is work nobody asked for.
       ${options.importId === undefined ? sql`` : sql`AND t.import_id = ${options.importId}::uuid`}
  `);

  const names = new Map(rules.map((rule) => [rule.categoryId, rule.categoryName]));
  const counts = new Map<string, number>();
  const changes: { id: string; categoryId: string; ruleId: string }[] = [];

  for (const row of rows) {
    const found = categorise(
      {
        description: row.description,
        amount: row.amount,
        accountId: row.account_id,
        accountClass: row.account_class,
      },
      rules,
    );
    if (found === null || found.categoryId === row.category_id) continue;

    changes.push({ id: row.id, categoryId: found.categoryId, ruleId: found.ruleId });
    const name = names.get(found.categoryId) ?? '';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  if (options.preview !== true) {
    for (const change of changes) {
      await tx.execute(sql`
        UPDATE entries
           SET category_id = ${change.categoryId}::uuid,
               categorised_by = ${change.ruleId}::uuid
         WHERE id = ${change.id}::bigint
      `);
    }
  }

  return {
    changed: changes.length,
    byCategory: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
