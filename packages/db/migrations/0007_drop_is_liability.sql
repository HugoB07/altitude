-- Drop the boolean now that `classification` carries the same information.
--
-- Split from 0006 so that neither migration is a swap: one adds, one removes,
-- and the state between them has both columns agreeing. A database stopped
-- halfway is still readable.
--
-- Nothing is lost. The column was GENERATED ALWAYS from `kind`, so every value
-- it held is recomputable, and `classification` already does.

ALTER TABLE "accounts" DROP COLUMN "is_liability";
