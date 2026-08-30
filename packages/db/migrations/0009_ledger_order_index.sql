-- The reading order of the ledger, indexed in full.
--
-- The list orders by (booked_on DESC, id DESC): the tiebreak is what keeps
-- paging stable when several transactions share a day. The index stopped at
-- booked_on, so it could not supply that order, and the planner did the
-- arithmetic and chose to read the whole table instead.
--
-- Measured on a million transactions in one household, twenty-five rows:
--
--   Seq Scan on transactions (actual rows=1021034) + Sort   190 ms
--   Index Scan, no sort at all                                1.5 ms
--
-- Replaced rather than added alongside: the wider index answers everything the
-- narrower one did, and two indexes on the same prefix is one to keep updated
-- for nothing.

DROP INDEX "transactions_household_booked_idx";--> statement-breakpoint
CREATE INDEX "transactions_household_booked_idx" ON "transactions" USING btree ("household_id","booked_on" DESC NULLS LAST,"id" DESC NULLS LAST);
