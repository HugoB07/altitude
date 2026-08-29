import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { households, owners } from './identity.js';

/**
 * Postgres `ltree`, which Drizzle has no built-in column type for.
 *
 * A materialised path rather than a parent pointer, so a whole subtree comes
 * back in one query — `path <@ 'home.investments'` — instead of a recursive CTE
 * per lookup. Every allocation and net-worth figure is scoped to a subtree, so
 * this is the hot path (plan §6.4).
 */
const ltree = customType<{ data: string; driverData: string }>({
  dataType: () => 'ltree',
});

export const PORTFOLIO_KINDS = ['standard', 'child', 'company', 'project'] as const;

export const portfolios = pgTable(
  'portfolios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Restricted, not cascaded: deleting a parent must not silently drop accounts. */
    parentId: uuid('parent_id'),
    path: ltree('path').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('standard'),
    color: text('color'),
    /** Target allocation, for rebalancing drift. */
    targetAlloc: jsonb('target_alloc'),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('portfolios_household_path_key').on(t.householdId, t.path),
    index('portfolios_household_idx').on(t.householdId),
  ],
);

/**
 * Every asset and every liability, in one table.
 *
 * `kind` drives how the valuation engine treats the account; `attributes` holds
 * whatever that kind needs — a PEA's opening date and cumulative contributions,
 * a property's address, a loan's rate — validated by a Zod schema keyed on
 * `subtype` rather than by a column per product (plan §5.3).
 */
export const ACCOUNT_KINDS = [
  'cash',
  'securities',
  'savings',
  'life_insurance',
  'retirement',
  'crypto',
  'real_estate',
  'vehicle',
  'collectible',
  'private_equity',
  'receivable',
  'loan',
  'credit_card',
  'other_liability',
] as const;

export const LIABILITY_KINDS = ['loan', 'credit_card', 'other_liability'] as const;

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    subtype: text('subtype'),
    currency: text('currency').notNull(),
    institution: text('institution'),
    /** IBAN or account number, encrypted application-side (plan §5.3). */
    externalRefEnc: text('external_ref_enc'),
    externalRefLast4: text('external_ref_last4'),
    attributes: jsonb('attributes').notNull().default({}),
    /**
     * Generated, not set by the application: a liability that stops counting as
     * one because an insert forgot the flag is a net-worth bug that hides.
     */
    isLiability: boolean('is_liability')
      .notNull()
      .generatedAlwaysAs(sql`kind IN ('loan', 'credit_card', 'other_liability')`),
    openedOn: date('opened_on'),
    closedOn: date('closed_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('accounts_household_idx').on(t.householdId),
    index('accounts_portfolio_idx').on(t.portfolioId),
  ],
);

export const OWNERSHIP_RIGHTS = ['full', 'usufruct', 'bare'] as const;

/**
 * An owner's dated share of an account.
 *
 * Dated because ownership moves: a gift, a change of marital regime, a new
 * shareholder. An overlap exclusion constraint (added in SQL, since Drizzle
 * cannot express `EXCLUDE USING gist`) stops the same owner holding two
 * overlapping shares of one account.
 */
export const ownerships = pgTable(
  'ownerships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    share: numeric('share', { precision: 9, scale: 6 }).notNull(),
    rightType: text('right_type').notNull().default('full'),
    validFrom: date('valid_from').notNull().default('-infinity'),
    validTo: date('valid_to').notNull().default('infinity'),
  },
  (t) => [index('ownerships_account_idx').on(t.accountId)],
);

export const portfoliosRelations = relations(portfolios, ({ one, many }) => ({
  household: one(households, { fields: [portfolios.householdId], references: [households.id] }),
  parent: one(portfolios, {
    fields: [portfolios.parentId],
    references: [portfolios.id],
    relationName: 'portfolio_parent',
  }),
  children: many(portfolios, { relationName: 'portfolio_parent' }),
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  household: one(households, { fields: [accounts.householdId], references: [households.id] }),
  portfolio: one(portfolios, { fields: [accounts.portfolioId], references: [portfolios.id] }),
  ownerships: many(ownerships),
}));

export const ownershipsRelations = relations(ownerships, ({ one }) => ({
  account: one(accounts, { fields: [ownerships.accountId], references: [accounts.id] }),
  owner: one(owners, { fields: [ownerships.ownerId], references: [owners.id] }),
}));
