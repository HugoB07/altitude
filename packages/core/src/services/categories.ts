import { asc, eq, sql } from 'drizzle-orm';
import {
  categories,
  categorisationRuleTags,
  categorisationRules,
  tags,
  transactionsTags,
  type Database,
} from '@altitude/db';
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
  /** Empty when the rule sets no category, which is allowed. */
  readonly categoryName: string;
  /** The names of `tagIds`, so a list of rules reads without a second query. */
  readonly tagNames: readonly string[];
}

export interface Tag {
  readonly id: string;
  readonly name: string;
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

  // A left join now: a rule may set only a counterparty or only tags, and an
  // inner join would silently drop it from the engine's own list.
  const rows = await tx.execute<{
    id: string;
    name: string;
    priority: number;
    conditions: unknown;
    category_id: string | null;
    counterparty: string | null;
    stop_on_match: boolean;
    category_name: string | null;
    tag_ids: readonly string[];
    tag_names: readonly string[];
  }>(sql`
    SELECT r.id,
           r.name,
           r.priority,
           r.conditions,
           r.category_id::text AS category_id,
           r.counterparty,
           r.stop_on_match,
           c.name AS category_name,
           COALESCE(
             (SELECT array_agg(g.id::text ORDER BY g.name)
                FROM categorisation_rule_tags rt
                JOIN tags g ON g.id = rt.tag_id
               WHERE rt.rule_id = r.id),
             ARRAY[]::text[]
           ) AS tag_ids,
           COALESCE(
             (SELECT array_agg(g.name ORDER BY g.name)
                FROM categorisation_rule_tags rt
                JOIN tags g ON g.id = rt.tag_id
               WHERE rt.rule_id = r.id),
             ARRAY[]::text[]
           ) AS tag_names
      FROM categorisation_rules r
      LEFT JOIN categories c ON c.id = r.category_id
     ORDER BY r.priority, r.id
  `);

  return [...rows].flatMap((row) => {
    const conditions = parseConditions(row.conditions);
    if (conditions === null) return [];
    return [
      {
        id: row.id,
        name: row.name,
        priority: row.priority,
        conditions,
        categoryId: row.category_id,
        counterparty: row.counterparty,
        tagIds: row.tag_ids,
        stopOnMatch: row.stop_on_match,
        categoryName: row.category_name ?? '',
        tagNames: row.tag_names,
      },
    ];
  });
}

export interface NewRule {
  readonly id: string;
  readonly name: string;
  readonly priority?: number;
  readonly conditions: unknown;
  /** At least one of these three, or the rule does nothing and is refused. */
  readonly categoryId?: CategoryId | null;
  readonly counterparty?: string | null;
  readonly tagIds?: readonly string[];
  readonly stopOnMatch?: boolean;
}

/**
 * Refuses a rule it could not read back, and one that would do nothing.
 *
 * A rule with no effect is checked here rather than by a constraint: the tags
 * live in their own table, so a CHECK could see two thirds of the question and
 * would turn down a rule that only tags - which is a perfectly good rule.
 */
export async function createRule(
  tx: Database,
  actor: Actor,
  input: NewRule,
): Promise<StoredRule | null> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const conditions = parseConditions(input.conditions);
  const name = input.name.trim();
  const counterparty = (input.counterparty ?? '').trim();
  const tagIds = input.tagIds ?? [];
  const categoryId = input.categoryId ?? null;

  if (conditions === null || name === '') return null;
  if (categoryId === null && counterparty === '' && tagIds.length === 0) return null;

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
      categoryId,
      ...(counterparty === '' ? {} : { counterparty }),
      stopOnMatch,
      createdBy: actor.userId,
    })
    .returning({ id: categorisationRules.id });

  if (made === undefined) return null;

  if (tagIds.length > 0) {
    await tx
      .insert(categorisationRuleTags)
      .values(tagIds.map((tagId) => ({ ruleId: made.id, tagId, householdId: actor.householdId })))
      .onConflictDoNothing();
  }

  // Read back rather than assembled from the input: the names come from rows,
  // and a tag id the household does not own inserts nothing above.
  return (await listRules(tx, actor)).find((rule) => rule.id === made.id) ?? null;
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

/**
 * The household's tags.
 *
 * Unlike a category, a tag claims nothing about totals: a movement carries
 * none, one or five, and they do not sum to anything. That is what lets them
 * cut across - a week in Spain is restaurants and fuel and a hotel, and each
 * keeps its own category.
 */
export async function listTags(tx: Database, actor: Actor): Promise<Tag[]> {
  assertCan(actor, 'category:read', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const rows = await tx.select({ id: tags.id, name: tags.name }).from(tags).orderBy(asc(tags.name));
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export async function createTag(
  tx: Database,
  actor: Actor,
  input: { readonly id: string; readonly name: string },
): Promise<Tag | null> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  const name = input.name.trim();
  if (name === '') return null;

  // Case-folded and unique, like a category: typing one that exists gives back
  // the one that exists rather than a second of the same name.
  const [made] = await tx
    .insert(tags)
    .values({ id: input.id, householdId: actor.householdId, name, createdBy: actor.userId })
    .onConflictDoNothing()
    .returning({ id: tags.id, name: tags.name });

  if (made !== undefined) return { id: made.id, name: made.name };

  const [existing] = await tx
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(sql`lower(${tags.name}) = lower(${name})`)
    .limit(1);

  return existing === undefined ? null : { id: existing.id, name: existing.name };
}

/**
 * Removes a tag, and with it every mark it made.
 *
 * The database says so: the join rows cascade, and so do the rules that apply
 * it. Nothing in the ledger moves - a tag is a label on a movement, not the
 * movement.
 */
export async function deleteTag(tx: Database, actor: Actor, id: string): Promise<void> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  await tx.delete(tags).where(eq(tags.id, id));
}

/**
 * Sets the tags on one transaction, replacing what it had.
 *
 * Replaced rather than merged because that is what the control does: somebody
 * ticks and unticks, and a call that only ever added would make unticking do
 * nothing.
 */
export async function setTransactionTags(
  tx: Database,
  actor: Actor,
  input: { readonly transactionId: string; readonly tagIds: readonly string[] },
): Promise<void> {
  assertCan(actor, 'category:write', { householdId: actor.householdId });
  await assertActorMatchesTenant(tx, actor);

  // Row-level security scopes both statements, so a transaction of another
  // household matches nothing and neither half of this does anything.
  await tx.execute(sql`
    DELETE FROM transactions_tags WHERE transaction_id = ${input.transactionId}::uuid
  `);

  if (input.tagIds.length === 0) return;

  await tx
    .insert(transactionsTags)
    .values(
      input.tagIds.map((tagId) => ({
        transactionId: input.transactionId,
        tagId,
        householdId: actor.householdId,
      })),
    )
    .onConflictDoNothing();
}

export interface ApplyResult {
  /** Entries whose category changed, or would change. */
  readonly changed: number;
  /** Transactions given a counterparty their bank did not name. */
  readonly named: number;
  /** Transactions a rule tagged. */
  readonly tagged: number;
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
  if (rules.length === 0) return { changed: 0, named: 0, tagged: 0, byCategory: [] };

  const rows = await tx.execute<{
    id: string;
    transaction_id: string;
    description: string | null;
    counterparty: string | null;
    amount: string;
    account_id: string;
    account_class: string;
    category_id: string | null;
  }>(sql`
    SELECT e.id::text AS id,
           t.id::text AS transaction_id,
           t.description,
           t.counterparty,
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
  const categorised: { id: string; categoryId: string; ruleId: string }[] = [];
  /** Keyed by transaction, because a counterparty and a tag belong to it, not to a side of it. */
  const named = new Map<string, string>();
  const tagged = new Map<string, Set<string>>();

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
    if (found === null) continue;

    if (
      found.categoryId !== null &&
      found.ruleId !== null &&
      found.categoryId !== row.category_id
    ) {
      categorised.push({ id: row.id, categoryId: found.categoryId, ruleId: found.ruleId });
      const name = names.get(found.categoryId) ?? '';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    // Only where the bank said nothing. A name the file itself carried is
    // better evidence than a pattern somebody wrote, and overwriting it would
    // replace what the bank knows with what a rule guesses.
    if (found.counterparty !== null && row.counterparty === null) {
      named.set(row.transaction_id, found.counterparty);
    }

    if (found.tagIds.length > 0) {
      const already = tagged.get(row.transaction_id) ?? new Set<string>();
      for (const tag of found.tagIds) already.add(tag);
      tagged.set(row.transaction_id, already);
    }
  }

  if (options.preview !== true) {
    for (const change of categorised) {
      await tx.execute(sql`
        UPDATE entries
           SET category_id = ${change.categoryId}::uuid,
               categorised_by = ${change.ruleId}::uuid
         WHERE id = ${change.id}::bigint
      `);
    }

    for (const [transactionId, counterparty] of named) {
      await tx.execute(sql`
        UPDATE transactions
           SET counterparty = ${counterparty}
         WHERE id = ${transactionId}::uuid
           AND counterparty IS NULL
      `);
    }

    for (const [transactionId, ids] of tagged) {
      await tx
        .insert(transactionsTags)
        .values([...ids].map((tagId) => ({ transactionId, tagId, householdId: actor.householdId })))
        .onConflictDoNothing();
    }
  }

  return {
    changed: categorised.length,
    named: named.size,
    tagged: tagged.size,
    byCategory: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
