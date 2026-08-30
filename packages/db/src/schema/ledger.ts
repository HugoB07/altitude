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
import { households, users } from './identity';
import { imports } from './imports';
import { instruments } from './instruments';
import { accounts } from './structure';

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
    /** Provider identifier - the idempotency key for imports and sync. */
    externalId: text('external_id'),
    /** sha256 over account, date, amount and normalised label (plan §8.5). */
    dedupeHash: text('dedupe_hash'),
    /** Set when this transaction cancels another: the ledger is append-only. */
    reversesId: uuid('reverses_id'),
    /**
     * The import run that created this row, when one did.
     *
     * Null for anything typed by hand. Set on rows an import wrote, so undoing
     * that import is a question the database can answer rather than a guess
     * from dates.
     */
    importId: uuid('import_id').references(() => imports.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: only rows that actually carry a provider id take part, so
    // manually entered transactions are not forced to invent one.
    uniqueIndex('transactions_external_id_key')
      .on(t.householdId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    /**
     * The ledger's reading order, in full.
     *
     * `id` is part of the key, not decoration: the list orders by
     * `booked_on DESC, id DESC` - the tiebreak is what keeps paging stable when
     * several transactions share a day - and an index that stops at `booked_on`
     * cannot supply that order. Measured on a million rows in one household, the
     * planner abandoned the index and sorted the whole table for twenty-five
     * rows: 190 ms, against 1.5 ms once the index covers the tiebreak.
     *
     * The household column stays first even though it is not selective on a
     * single-household instance. It is the RLS predicate, so it is in every
     * query, and dropping it would make this index unusable the moment a second
     * household exists.
     */
    index('transactions_household_booked_idx').on(t.householdId, t.bookedOn.desc(), t.id.desc()),
    /**
     * Answering "was this reversed?" without reading the table.
     *
     * The ledger screen asks it once per row. Without this index each question
     * is a sequential scan: measured at a million transactions, twenty-five rows
     * cost 1.65 seconds and examined twenty-five million. With it, the same page
     * is a few milliseconds.
     *
     * Partial, because a reversal is the exception. Only the rows that cancel
     * something are in the index, so it stays small and its scan stays short.
     */
    /**
     * Filtering the ledger by kind, in the ledger's own order.
     *
     * The four columns are the whole point: household because row-level
     * security adds it to every query, kind because that is the filter, and the
     * ordering pair so the matching rows come back sorted without a sort step.
     * Measured on a million transactions: counting one kind went from 217 ms on
     * a sequential scan to 26 ms, and the filtered page became an index-only
     * scan of twenty-five rows.
     *
     * 64 MB at a million rows, and one more index to maintain on every insert.
     * Worth it for a filter people reach for - show me every fee, every
     * dividend - and it would not be for one nobody uses.
     */
    index('transactions_household_kind_idx').on(
      t.householdId,
      t.kind,
      t.bookedOn.desc(),
      t.id.desc(),
    ),
    index('transactions_reverses_idx')
      .on(t.reversesId)
      .where(sql`${t.reversesId} IS NOT NULL`),
  ],
);

/**
 * One side of a transaction.
 *
 * `amount` is signed from the account's point of view. The sum across a
 * transaction is zero per currency, enforced by a deferred constraint trigger
 * defined in SQL rather than here - see migrations (ADR-0002).
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
    /** References `instruments`, which is shared reference data outside any household. */
    instrumentId: uuid('instrument_id').references(() => instruments.id),
    quantity: numeric('quantity', { precision: 38, scale: 18 }),
    unitPrice: numeric('unit_price', { precision: 24, scale: 12 }),
    /** Rate to the household base currency, frozen at booking time. */
    fxRateToBase: numeric('fx_rate_to_base', { precision: 24, scale: 12 }),
    categoryId: uuid('category_id'),
    memo: text('memo'),
  },
  (t) => [
    /**
     * Balances without touching the table.
     *
     * `amount` rides along so summing an account is an index-only scan: the
     * dashboard adds up every entry an account has ever had, and reading two
     * million rows out of the heap to sum one column is most of what that costs.
     * Measured on two million entries, seven accounts: 939 ms against 445 ms,
     * with heap fetches dropping from all of them to sixty-nine.
     *
     * `household_id` leads, and that is the part that was learned the hard way.
     * Every query against this table runs under row-level security, which adds
     * `household_id = current_household()` to it - so an index without that
     * column cannot answer on its own, and PostgreSQL falls back to reading the
     * heap to check it. Measured as the application role, which is the only
     * role that matters:
     *
     *   without household_id   1,912 ms, 108,797 blocks read
     *   with it                    433 ms, 69 heap fetches
     *
     * `amount` is a key column rather than INCLUDE, which would be the better
     * shape since it is never filtered or ordered on. Drizzle 0.45 cannot
     * express INCLUDE, and a hand-written migration would leave the schema
     * describing an index the database does not have. Measured, the two forms
     * are the same size and the same speed.
     *
     * 551 ms is still linear in the number of entries. Making it constant means
     * storing balances rather than deriving them, which is ADR-0008.
     */
    index('entries_account_idx').on(t.householdId, t.accountId, t.transactionId, t.amount),
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
