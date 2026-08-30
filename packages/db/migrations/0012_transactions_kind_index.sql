-- Filtering by kind, in the ledger's own order.
--
-- Four columns and each earns its place: household_id because row-level
-- security adds it to every query, kind because that is what is being filtered,
-- and the ordering pair so the matching rows arrive sorted with no sort step.
--
-- Measured on a million transactions:
--
--   count of one kind, sequential scan   217 ms
--   count of one kind, index-only         26 ms
--   filtered page 1                       index-only scan of 25 rows
--
-- 64 MB, and one more index to keep current on every insert. That is worth
-- paying for a filter people reach for and would not be for one nobody uses.

CREATE INDEX "transactions_household_kind_idx" ON "transactions" USING btree ("household_id","kind","booked_on" DESC NULLS LAST,"id" DESC NULLS LAST);
