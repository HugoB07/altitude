-- Balances read from the index instead of the table.
--
-- The dashboard sums every entry an account has ever had. With amount living
-- only in the heap, that meant reading two million rows to add up one column.
-- Carrying it in the index turns the aggregation into an index-only scan.
--
-- Measured on two million entries across seven accounts:
--
--   Bitmap Heap Scan, 2,042,068 heap rows    939 ms
--   Index Only Scan,  69 heap fetches        442 ms
--
-- The wider index is no larger than the one it replaces: 115 MB against 127.
--
-- Still linear in the number of entries, and that is as far as an index goes.
-- A dashboard whose cost does not grow with history has to store balances
-- rather than derive them, which is ADR-0008 and a feature, not an index.

DROP INDEX "entries_account_idx";--> statement-breakpoint
CREATE INDEX "entries_account_idx" ON "entries" USING btree ("account_id","transaction_id","amount");
