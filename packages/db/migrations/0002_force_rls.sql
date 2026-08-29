-- Make row-level security apply to the table owner as well.
--
-- ENABLE ROW LEVEL SECURITY, added in 0001, does not apply to the role that
-- owns the tables. PostgreSQL exempts owners by default. That exemption turns
-- the second barrier of ADR-0007 into decoration the moment DATABASE_URL points
-- at the owning role - which is the obvious thing to configure, and is exactly
-- what docker-compose.dev.yml hands out.
--
-- The failure mode is the dangerous kind: nothing errors, pg_class still reports
-- relrowsecurity = true, and every policy is listed in pg_policies. The barrier
-- looks present in every place someone would think to check, and passes no rows
-- through a filter.
--
-- FORCE closes it. The migration role keeps its BYPASSRLS attribute, which
-- overrides FORCE, so migrations and maintenance still reach every household.

ALTER TABLE households   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships  FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE owners       FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE portfolios   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts     FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ownerships   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entries      FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The policies in 0001 are USING-only, which governs what an existing row lets
-- you see. Under FORCE that leaves INSERT unguarded: a row could be written
-- into another household and then become invisible to its author.
--
-- WITH CHECK governs what may be written. Splitting them per command rather
-- than using FOR ALL keeps the two readable, and makes it obvious that a write
-- is constrained to the current tenant.
CREATE POLICY household_write ON households
  FOR INSERT WITH CHECK (id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON memberships
  FOR INSERT WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON owners
  FOR INSERT WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON portfolios
  FOR INSERT WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON accounts
  FOR INSERT WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON transactions
  FOR INSERT WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON entries
  FOR INSERT WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON ownerships
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
     WHERE a.id = ownerships.account_id
       AND a.household_id = current_household()
  ));
--> statement-breakpoint

-- UPDATE needs both: USING decides which rows may be targeted, WITH CHECK
-- decides what they may become. Without the second, a row could be updated out
-- of its own household.
CREATE POLICY household_update ON households
  FOR UPDATE USING (id = current_household()) WITH CHECK (id = current_household());
--> statement-breakpoint
CREATE POLICY household_update ON memberships
  FOR UPDATE USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_update ON owners
  FOR UPDATE USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_update ON portfolios
  FOR UPDATE USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_update ON accounts
  FOR UPDATE USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_update ON transactions
  FOR UPDATE USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_update ON entries
  FOR UPDATE USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint

-- Grants in 0001 covered the tables that existed then. Default privileges cover
-- the ones later migrations will create, so adding a table cannot silently
-- leave the application role unable to read it - a failure that would surface
-- as a permission error in production long after the migration looked fine.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO altitude_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO altitude_app;
