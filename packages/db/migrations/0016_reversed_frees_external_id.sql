-- A reversed transaction stops reserving its provider identifier.
--
-- `transactions_external_id_key` is what makes re-importing a file add nothing:
-- the provider's own id is unique per household, so the second import matches
-- rather than duplicates. After an import is rolled back, that same uniqueness
-- made the file impossible to import again - the originals still held the ids,
-- so every row collided with a transaction that had already been cancelled.
--
-- The screen promises "you can import the file again afterwards", and this is
-- what makes that true. A cancelled transaction keeps its identifier for the
-- record; it just no longer stands in the way of the movement it described
-- being recorded again.
--
-- Denormalised on purpose. Whether a transaction is reversed is otherwise a
-- correlated subquery, and a partial unique index cannot be written over one.
ALTER TABLE transactions ADD COLUMN reversed_at timestamptz;

-- Existing pairs, so the column is true of what is already there rather than
-- true only of what happens next.
UPDATE transactions t
   SET reversed_at = r.created_at
  FROM transactions r
 WHERE r.reverses_id = t.id;

DROP INDEX "transactions_external_id_key";

CREATE UNIQUE INDEX "transactions_external_id_key"
    ON transactions USING btree (household_id, external_id)
 WHERE external_id IS NOT NULL AND reversed_at IS NULL;
