import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { households, users } from './identity';

/**
 * One run of an import, so that undoing it means something.
 *
 * `import:rollback` has been in the authorisation policy since day one with
 * nothing behind it, and this is what it needs: a name for the set of
 * transactions a single file produced. Without it, undoing an import means
 * finding its rows by date and hoping nothing else was recorded that day.
 *
 * The batch is kept after the transactions it made are reversed. What was
 * imported, from which file, by whom, is history in its own right - and a
 * ledger that erases the record of a correction is the ledger ADR-0002 exists
 * to avoid.
 */
export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Which reader produced it: a preset name, or `custom` for a hand mapping. */
    source: text('source').notNull(),
    /** As the person uploaded it, for recognising a file six months later. */
    filename: text('filename').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the run was undone, and by whom. Null while it still stands.
     *
     * The reversals are the truth - every transaction the run made has an
     * opposite, and nothing is deleted. This is the answer to "has this already
     * been undone?", which is otherwise a count of transactions and their
     * reversals every time the list is drawn, and which two people pressing the
     * button at the same moment could both get wrong.
     */
    rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
    rolledBackBy: uuid('rolled_back_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('imports_household_idx').on(t.householdId, t.createdAt.desc())],
);
