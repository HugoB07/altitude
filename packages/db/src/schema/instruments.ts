import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * What kind of thing an instrument is.
 *
 * Coarse on purpose. This drives how a holding is described, not how it is
 * valued - valuation is phase 3 and will need far more than six words.
 */
export const INSTRUMENT_KINDS = ['equity', 'fund', 'bond', 'crypto', 'commodity', 'other'] as const;

export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

/**
 * A dictionary of things that can be held. Not a price engine.
 *
 * It exists because a purchase cannot be recorded without it. A buy is two
 * entries summing to zero - cash out, holding in - and the holding line carries
 * a quantity, which the ledger refuses without an instrument to attach it to
 * (`InconsistentHoldingError`). Importing a broker export without this table
 * would mean inventing a "securities" account that receives value in bulk, and
 * later re-deriving real positions from text nobody meant to parse.
 *
 * Deliberately outside every household. An ISIN means the same thing to
 * everyone, so duplicating the row per household would be storing the same fact
 * many times and letting the copies drift. That also means no `household_id`
 * and no row-level security policy, which is correct rather than an oversight:
 * this table holds no household data. Knowing that FR0011550193 exists tells
 * you nothing about who owns it - that lives in `entries`, which is scoped.
 *
 * Nothing here is a price, a valuation, or a provider identifier. See ADR-0011.
 */
export const instruments = pgTable(
  'instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The identifier the world agrees on, where one exists.
     *
     * Nullable because plenty of holdings have none: crypto, unlisted shares,
     * a stake in a company. Unique only among the rows that have one, so those
     * cannot be entered twice while the rest are not forced to invent a value.
     */
    isin: text('isin'),
    /** Ticker, which is neither unique nor stable, and is only ever a label. */
    symbol: text('symbol'),
    name: text('name').notNull(),
    /** The currency the instrument is denominated in, not the household's. */
    currency: text('currency').notNull(),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('instruments_isin_key')
      .on(t.isin)
      .where(sql`${t.isin} IS NOT NULL`),
    index('instruments_symbol_idx').on(t.symbol),
  ],
);
