-- An index on reverses_id, and the measurement that found it missing.
--
-- The ledger screen asks "was this transaction reversed?" once per row. The
-- column had no index, so each question was a sequential scan of the whole
-- table. Measured on a million transactions, one household, twenty-five rows:
--
--   Seq Scan on transactions r (loops=25)  Rows Removed by Filter: 1000000
--   Execution Time: 1658 ms
--
-- Twenty-five million rows examined to return twenty-five. This turns that into
-- an index lookup.
--
-- Partial: a reversal is the exception, so only the rows that cancel something
-- take part and the index stays a fraction of the table.

CREATE INDEX "transactions_reverses_idx" ON "transactions" USING btree ("reverses_id") WHERE "transactions"."reverses_id" IS NOT NULL;
