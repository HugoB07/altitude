-- The keys by which an import recognises a transaction it has seen before.
--
-- A table rather than the `dedupe_hash` column it replaces, because one
-- transaction has more than one of these. A bank re-exporting a month writes
-- the same movement differently - the operation date one time and the value
-- date the next, the mandate reference once and not again - and a person who
-- says "this line is the transaction I already have" is adding a second way of
-- writing it, not correcting the first. A single column would make the two
-- exports take turns overwriting each other, and each import would ask the
-- same question again.
--
-- The key itself is sha256 over the date, the entries and the normalised label
-- (plan §8.5).
CREATE TABLE transactions_dedupe_keys (
  transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Not unique on (household_id, hash): two identical direct debits on one day
  -- hash the same and are both real. Deduplication consumes matches one at a
  -- time for exactly that reason, and a unique index here would instead make
  -- the second one impossible to record.
  PRIMARY KEY (transaction_id, hash)
);

CREATE INDEX transactions_dedupe_keys_lookup
    ON transactions_dedupe_keys (household_id, hash);
--> statement-breakpoint

-- Never written: the column has been in the schema since the first migration
-- and nothing ever set it, so there is nothing to carry over.
ALTER TABLE transactions DROP COLUMN dedupe_hash;
--> statement-breakpoint

-- Written by hand because drizzle-kit does not generate policies, and every
-- table carrying household data must have one (ADR-0007).
ALTER TABLE transactions_dedupe_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions_dedupe_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY transactions_dedupe_keys_tenant ON transactions_dedupe_keys
  USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
