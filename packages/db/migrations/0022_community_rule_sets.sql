-- Rules nobody in a household had to write.
--
-- The plan asks for a community rule set per country, versioned in the
-- repository, running after the household's own rules (§8.6). Until now a
-- fresh install had no rules at all: the first import categorised nothing, and
-- every person who installed Altitude wrote CARREFOUR, then LECLERC, then
-- INTERMARCHE for themselves, separately, forever.
--
-- The set is files rather than rows, and that is the whole design. Copied into
-- each household at setup it would be frozen there: a rule found to be wrong
-- would stay wrong in every database that had already taken it, and there is
-- no migration that can safely edit somebody's categorisations after the fact.
-- Read from the files on every pass, a correction reaches everyone at the next
-- update, and a household that disagrees writes its own rule over it.
--
-- Three columns, and no table. What has to be stored is only what a household
-- decided: which set it uses, which of its categories a shipped rule can point
-- at, and which shipped rule decided a given entry.

-- A stable name for a category, so a rule in a file can point at a row.
--
-- A shipped rule says "groceries". It cannot say a uuid: the row is created per
-- household, and a rule written once for everybody has no way to know it. The
-- key is the join, and it is nullable because a category somebody made up
-- themselves has no business carrying one.
ALTER TABLE categories ADD COLUMN key text;
--> statement-breakpoint

-- Unique where present, and silent where absent. A partial index is what says
-- "at most one groceries per household" without claiming anything about the
-- twenty categories a person invented.
CREATE UNIQUE INDEX categories_key_key ON categories (household_id, key)
  WHERE key IS NOT NULL;
--> statement-breakpoint

-- Which shipped rule decided this, when one did.
--
-- Text rather than a second uuid, and a second column rather than a wider one.
-- `categorised_by` references `categorisation_rules` so that deleting a rule
-- lets go of the entries it decided; a shipped rule is a file with no row to
-- reference and no row to delete. Exactly one of the two is set, and together
-- they are the honest answer to "why is this in groceries".
ALTER TABLE entries ADD COLUMN categorised_by_set text;
--> statement-breakpoint

-- Which set a household uses, or none.
--
-- Off until somebody turns it on, like everything else here that acts without
-- being asked each time. A set is a country's - `fr` - because what a shop is
-- called and what it sells is a fact about a country, not about a language.
ALTER TABLE households ADD COLUMN rule_set text;
