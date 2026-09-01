import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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

/**
 * A description of a bank's file, kept so it is written once.
 *
 * Scoped to a household deliberately. A mapping holds no figures - it says
 * "this file's third column is the amount" - but its existence says which bank
 * somebody uses. `instruments` accepts that kind of leak because phase 3 seeds
 * it with a public catalogue that dissolves it (ADR-0011); nothing would ever
 * dissolve this one, since the table only ever holds what people imported.
 *
 * Sharing goes through the repository instead: a mapping worth having by
 * everyone ships as a preset, which is a file in git rather than a row here.
 */
export const importsMappings = pgTable(
  'imports_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** What the person called it, so a list of them is readable. */
    name: text('name').notNull(),
    /**
     * The header row and the delimiter.
     *
     * What two exports of the same bank agree on, and everything else differs
     * by. Unique per household: a second description of the same shape is a
     * correction rather than an addition.
     */
    fingerprint: text('fingerprint').notNull(),
    /** The `ColumnMapping`, validated on the way in and on the way back out. */
    mapping: jsonb('mapping').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('imports_mappings_fingerprint_key').on(t.householdId, t.fingerprint)],
);
