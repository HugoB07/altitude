-- The ledger invariant, in SQL.
--
-- packages/core already refuses an unbalanced transaction. This does it again,
-- in the database, and that duplication is deliberate: the application is one
-- of several ways rows can arrive — a migration, a repair script, psql, a
-- future importer written by someone who has not read ADR-0002. An invariant
-- enforced only by the code that happens to be in front of it is not enforced.

-- ── Balance: every currency sums to zero ────────────────────────────────
CREATE OR REPLACE FUNCTION assert_transaction_balanced() RETURNS trigger AS $$
DECLARE
  offending record;
BEGIN
  SELECT currency, sum(amount) AS residual
    INTO offending
    FROM entries
   WHERE transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id)
   GROUP BY currency
  HAVING sum(amount) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'transaction % does not balance: % off by %',
      COALESCE(NEW.transaction_id, OLD.transaction_id),
      offending.currency,
      offending.residual
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- DEFERRABLE INITIALLY DEFERRED is what makes this usable rather than merely
-- correct. The check runs at COMMIT, so entries can be inserted one at a time;
-- without deferral the first row of every transaction would fail, being alone
-- and therefore unbalanced.
CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();
--> statement-breakpoint

-- A transaction needs at least two sides. Checked at COMMIT for the same
-- reason, and on the transaction rather than per entry, because "how many
-- entries exist" is only knowable once they all do.
CREATE OR REPLACE FUNCTION assert_transaction_has_entries() RETURNS trigger AS $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM entries WHERE transaction_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'transaction % has % entries: at least two are required', NEW.id, n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER transactions_have_entries
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_has_entries();
--> statement-breakpoint

-- A line carrying a quantity must name its instrument, and the reverse. Cheap
-- enough to be a plain CHECK: it needs only the row itself.
ALTER TABLE entries ADD CONSTRAINT entries_holding_consistent
  CHECK ((quantity IS NULL) = (instrument_id IS NULL));
--> statement-breakpoint

ALTER TABLE entries ADD CONSTRAINT entries_unit_price_needs_quantity
  CHECK (unit_price IS NULL OR quantity IS NOT NULL);
--> statement-breakpoint

ALTER TABLE transactions ADD CONSTRAINT transactions_value_after_booking
  CHECK (value_on IS NULL OR value_on >= booked_on);
--> statement-breakpoint

-- ── Structure ───────────────────────────────────────────────────────────
-- GiST over the ltree path: this is what makes `path <@ 'home.investments'`
-- an index scan rather than a sequential one. Every allocation and net-worth
-- figure is scoped to a subtree, so it is the hot path.
CREATE INDEX portfolios_path_gist ON portfolios USING gist (path);
--> statement-breakpoint

ALTER TABLE portfolios ADD CONSTRAINT portfolios_parent_fk
  FOREIGN KEY (parent_id) REFERENCES portfolios(id) ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE transactions ADD CONSTRAINT transactions_reverses_fk
  FOREIGN KEY (reverses_id) REFERENCES transactions(id) ON DELETE RESTRICT;
--> statement-breakpoint

-- One owner cannot hold two overlapping shares of the same account. Needs
-- btree_gist to mix equality on uuid with range overlap, which is why the
-- extension is installed.
ALTER TABLE ownerships ADD CONSTRAINT ownerships_no_overlap
  EXCLUDE USING gist (
    account_id WITH =,
    owner_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  );
--> statement-breakpoint

ALTER TABLE ownerships ADD CONSTRAINT ownerships_share_range
  CHECK (share > 0 AND share <= 1);
--> statement-breakpoint

-- ── Row-level security (ADR-0007) ───────────────────────────────────────
-- The second of two barriers. The application already scopes every query by
-- household; this makes a query that forgets to do so return nothing instead
-- of another household's net worth.
ALTER TABLE households  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE owners      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE portfolios  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ownerships  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entries     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- current_setting(..., true) returns NULL rather than raising when the setting
-- is absent, and `household_id = NULL` is NULL, so a connection that forgot to
-- set the tenant sees no rows. Failing closed is the point.
CREATE OR REPLACE FUNCTION current_household() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.current_household', true), '')::uuid;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE POLICY household_isolation ON households
  USING (id = current_household());
--> statement-breakpoint
CREATE POLICY household_isolation ON memberships
  USING (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_isolation ON owners
  USING (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_isolation ON portfolios
  USING (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_isolation ON accounts
  USING (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_isolation ON transactions
  USING (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_isolation ON entries
  USING (household_id = current_household());
--> statement-breakpoint

-- ownerships has no household_id of its own; it inherits the tenant of the
-- account it points at. Denormalising the column would be faster but gives the
-- two a chance to disagree, and a disagreement here is a cross-tenant leak.
CREATE POLICY household_isolation ON ownerships
  USING (EXISTS (
    SELECT 1 FROM accounts a
     WHERE a.id = ownerships.account_id
       AND a.household_id = current_household()
  ));
--> statement-breakpoint

-- The application role is subject to RLS. The migration role is not, and is the
-- only one that may reach across households.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO altitude_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO altitude_app;
