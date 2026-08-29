import { relations } from 'drizzle-orm';
import { boolean, date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * A household is the tenant boundary. Every business row carries its id, and
 * row-level security is keyed on it (ADR-0007).
 */
export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Currency every figure is consolidated into. Changeable, but never silently. */
  baseCurrency: text('base_currency').notNull().default('EUR'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Someone who signs in. Distinct from an owner - see ADR-0003.
 *
 * Also Better Auth's `user` model. Mapping it onto this table rather than
 * letting Better Auth create a second one keeps memberships.user_id and
 * owners.user_id pointing at the same row a session refers to.
 *
 * No row-level security: a user exists before any household is known, and may
 * belong to several. Tenancy begins once a session resolves to a membership.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  /**
   * Better Auth calls this field `name`; its config maps the two rather than
   * the column being renamed. A rename would need an interactive resolution in
   * drizzle-kit - it cannot tell a rename from a drop plus an add - and would
   * put a destructive step in a migration for the sake of a label.
   */
  displayName: text('display_name').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'contributor', 'viewer', 'child'] as const;

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memberships_household_idx').on(t.householdId, t.userId)],
);

export const OWNER_KINDS = ['person', 'child', 'company', 'trust', 'undivided'] as const;

/**
 * Someone or something that *owns* value.
 *
 * A six-year-old owns a savings account without having a login; a holding
 * company owns a flat without being a person. Conflating this with `users` is
 * what makes child portfolios and joint ownership impossible to model later.
 */
export const owners = pgTable(
  'owners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    displayName: text('display_name').notNull(),
    /** Drives the visibility switch at majority (plan §10.2). */
    birthDate: date('birth_date'),
    /** Null when the owner never signs in - a child, or a company. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Company number, legal form, marital regime. Validated by Zod, not by SQL. */
    attributes: jsonb('attributes').notNull().default({}),
    isArchived: boolean('is_archived').notNull().default(false),
  },
  (t) => [index('owners_household_idx').on(t.householdId)],
);

export const householdsRelations = relations(households, ({ many }) => ({
  memberships: many(memberships),
  owners: many(owners),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  household: one(households, { fields: [memberships.householdId], references: [households.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const ownersRelations = relations(owners, ({ one }) => ({
  household: one(households, { fields: [owners.householdId], references: [households.id] }),
  user: one(users, { fields: [owners.userId], references: [users.id] }),
}));
