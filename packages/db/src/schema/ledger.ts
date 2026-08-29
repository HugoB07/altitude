import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { households, users } from './identity.js';
import { accounts } from './structure.js';

export const TRANSACTION_KINDS = [
  'buy',
  'sell',
  'dividend',
  'interest',
  'fee',
  'tax',
  'deposit',
  'withdrawal',
  'transfer',
  'fx',
  'revaluation',
  'split',
  'adjustment',
] as const;

export const TRANSACTION_SOURCES = ['manual', 'import', 'connector', 'rule'] as const;

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /**
     * `date`, not `timestamptz`, and deliberately so: an accounting date is a
     * calendar day, not an instant. Storing it with a timezone moves a
     * transaction across a month boundary depending on where it is read.
     */
    bookedOn: date('booked_on').notNull(),
    valueOn: date('value_on'),
    kind: text('kind').notNull(),
    description: text('description'),
    counterparty: text('counterparty'),
    source: text('source').notNull().default('manual'),
    /** Provider identifier — the idempotency key for imports and sync. */
    externalId: text('external_id'),
    /** sha256 over account, date, amount and normalised label (plan §8.5). */
    dedupeHash: text('dedupe_hash'),
    /** Set when this transaction cancels another: the ledger is append-only. */
    reversesId: uuid('reverses_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: only rows that actually carry a provider id take part, so
    // manually entered transactions are not forced to invent one.
    uniqueIndex('transactions_external_id_key')
      .on(t.householdId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('transactions_household_booked_idx').on(t.householdId, t.bookedOn.desc()),
  ],
);

/**
 * One side of a transaction.
 *
 * `amount` is signed from the account's point of view. The sum across a
 * transaction is zero per currency, enforced by a deferred constraint trigger
 * defined in SQL rather than here — see migrations (ADR-0002).
 */
export const entries = pgTable(
  'entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    householdId: uuid('household_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    // numeric, never float8. Drizzle returns these as strings, which is exactly
    // what Money expects at the boundary (ADR-0006).
    amount: numeric('amount', { precision: 28, scale: 10 }).notNull(),
    currency: text('currency').notNull(),
    instrumentId: uuid('instrument_id'),
    quantity: numeric('quantity', { precision: 38, scale: 18 }),
    unitPrice: numeric('unit_price', { precision: 24, scale: 12 }),
    /** Rate to the household base currency, frozen at booking time. */
    fxRateToBase: numeric('fx_rate_to_base', { precision: 24, scale: 12 }),
    categoryId: uuid('category_id'),
    memo: text('memo'),
  },
  (t) => [
    index('entries_account_idx').on(t.accountId, t.transactionId),
    index('entries_transaction_idx').on(t.transactionId),
  ],
);

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  household: one(households, { fields: [transactions.householdId], references: [households.id] }),
  entries: many(entries),
  reverses: one(transactions, {
    fields: [transactions.reversesId],
    references: [transactions.id],
    relationName: 'transaction_reversal',
  }),
}));

export const entriesRelations = relations(entries, ({ one }) => ({
  transaction: one(transactions, {
    fields: [entries.transactionId],
    references: [transactions.id],
  }),
  account: one(accounts, { fields: [entries.accountId], references: [accounts.id] }),
}));
