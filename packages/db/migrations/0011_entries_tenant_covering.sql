-- The same index again, this time with the column row-level security needs.
--
-- 0010 added `amount` so balances could be summed from the index, and measured
-- it as a superuser - which bypasses RLS entirely. The application does not.
-- Every query it makes carries `household_id = current_household()`, and an
-- index without that column cannot satisfy it: PostgreSQL reads the heap to
-- check, and the index-only scan that 0010 was written for never happened.
--
-- Measured as altitude_app, with the tenant set, which is the only role that
-- matters:
--
--   0010's index    1,912 ms   108,797 blocks read from disk
--   this one          551 ms   69 heap fetches
--
-- Left as a second migration rather than folded into 0010: nothing has been
-- released, but rewriting an applied migration to hide a mistake makes the
-- history lie about what was learned, and this one is worth remembering.

DROP INDEX "entries_account_idx";--> statement-breakpoint
CREATE INDEX "entries_account_idx" ON "entries" USING btree ("household_id","account_id","transaction_id","amount");
