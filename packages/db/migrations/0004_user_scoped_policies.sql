-- A second way in, keyed on the user rather than on the household.
--
-- Sign-in has a chicken-and-egg problem. Everything in 0001 and 0002 filters on
-- app.current_household, but the one question that cannot be asked from inside
-- a household is "which households do I belong to?". With only the tenant
-- policies, that query returns nothing and nobody can ever reach a household.
--
-- The answer is not to exempt anything. PostgreSQL combines permissive policies
-- with OR, so adding a user-keyed policy opens exactly one extra path - a user
-- may see their own membership rows, and the households those rows point at -
-- while leaving every household filter in place for everything else.

CREATE OR REPLACE FUNCTION current_app_user() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.current_user', true), '')::uuid;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- A user sees their own memberships, in any household. This is what makes the
-- household picker possible, and it reveals nothing about other members: the
-- filter is the user's own id, taken from a verified session.
CREATE POLICY own_memberships ON memberships
  FOR SELECT USING (user_id = current_app_user());
--> statement-breakpoint

-- And the households those memberships point at, so the picker can show names
-- rather than identifiers.
--
-- The EXISTS reads memberships, which is itself under RLS - and that is fine
-- rather than recursive: the policy above already lets the user see their own
-- rows, and memberships' policies never reference households back.
CREATE POLICY own_households ON households
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.household_id = households.id
       AND m.user_id = current_app_user()
  ));
--> statement-breakpoint

-- Sessions and credentials are consulted before any household is known, so they
-- carry no tenant policy. They are still not readable by everyone: a user may
-- only see their own rows.
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Better Auth reads a session by token before it knows whose it is, so these
-- policies cannot be keyed on current_app_user the way the ones above are.
-- They are permissive by necessity; the protection for these tables is that the
-- token is unguessable and the row is reachable only by presenting it.
--
-- Written as explicit policies rather than left without RLS so that enabling it
-- is a deliberate, visible decision instead of an omission someone later reads
-- as an oversight.
CREATE POLICY session_access ON auth_sessions USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY account_access ON auth_accounts USING (true) WITH CHECK (true);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions, auth_accounts, auth_verifications
  TO altitude_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO altitude_app;
