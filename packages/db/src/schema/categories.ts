import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  primaryKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { households, users } from './identity';

/**
 * What a movement was for.
 *
 * Held against the entry rather than the transaction (plan §5), which is what
 * will let one expense be split across several of these without changing the
 * shape of anything.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Case-folded in the migration, which drizzle-kit cannot express: this
  // declaration exists so the schema knows the index is there.
  (t) => [uniqueIndex('categories_name_key').on(t.householdId, t.name)],
);

/**
 * The ordered, deterministic engine that decides a category (plan §8.6).
 *
 * `conditions` is data and the outcome is a reference. The conditions will
 * grow - counterparty, kind, tags - and a column each would be a migration
 * each time, while a category is a row the database can enforce and cascade.
 */
export const categorisationRules = pgTable(
  'categorisation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Lower runs first. Not unique: adding a rule should not renumber the others. */
    priority: integer('priority').notNull().default(100),
    conditions: jsonb('conditions').notNull(),
    /**
     * Optional since a rule may only set a counterparty, or only tags.
     *
     * What stops a rule with no effect at all is `createRule` rather than a
     * constraint: the tags live in another table, so a CHECK could see two
     * thirds of the question and would refuse a rule that only tags.
     */
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'cascade' }),
    /** Who was on the other side, for the statements whose bank does not say. */
    counterparty: text('counterparty'),
    stopOnMatch: boolean('stop_on_match').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('categorisation_rules_order').on(t.householdId, t.priority, t.id)],
);

/**
 * Labels that cut across categories.
 *
 * A category is exclusive, so categories sum to the total and a breakdown is
 * honest. A tag is not: a movement has none, one or five of them, and they sum
 * to nothing. That is what makes both worth having - a week in Spain is
 * restaurants and fuel and a hotel, and making it a category would lose all
 * three.
 *
 * On the transaction rather than the entry, unlike a category: "spain-2026" is
 * not a share of anything, and putting it on each side would double the count.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Case-folded in the migration, which drizzle-kit cannot express.
  (t) => [uniqueIndex('tags_name_key').on(t.householdId, t.name)],
);

export const transactionsTags = pgTable(
  'transactions_tags',
  {
    transactionId: uuid('transaction_id').notNull(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.tagId] }),
    index('transactions_tags_lookup').on(t.householdId, t.tagId, t.transactionId),
  ],
);

/** Tags a rule applies, which is the plan's `then: { tags: [...] }` (§8.6). */
export const categorisationRuleTags = pgTable(
  'categorisation_rule_tags',
  {
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => categorisationRules.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.tagId] })],
);

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  household: one(households, { fields: [categories.householdId], references: [households.id] }),
  rules: many(categorisationRules),
}));

export const categorisationRulesRelations = relations(categorisationRules, ({ one }) => ({
  household: one(households, {
    fields: [categorisationRules.householdId],
    references: [households.id],
  }),
  category: one(categories, {
    fields: [categorisationRules.categoryId],
    references: [categories.id],
  }),
}));
