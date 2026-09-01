import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  index,
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
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    stopOnMatch: boolean('stop_on_match').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('categorisation_rules_order').on(t.householdId, t.priority, t.id)],
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
