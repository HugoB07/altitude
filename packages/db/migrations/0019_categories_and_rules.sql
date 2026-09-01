-- What a movement was for, and the rules that decide it.
--
-- The category sits on the entry rather than the transaction, which is what
-- the plan's schema says (§5) and what lets a 120 euro expense be split across
-- three of them later without changing anything here.
--
-- An entry on an equity account never carries one. That account is the edge of
-- the household - where money comes from and goes to - so "groceries" on its
-- side of a purchase would count the same spending twice. Net worth already
-- excludes equity for the same reason.
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Case-folded, so "Courses" and "courses" are one category rather than two a
-- person has to notice they created.
CREATE UNIQUE INDEX categories_name_key ON categories (household_id, lower(name));
--> statement-breakpoint

-- The column has been there since the first migration with nothing to point
-- at. Now that there is, the database can hold the reference rather than the
-- application remembering to.
ALTER TABLE entries
  ADD CONSTRAINT entries_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL;
--> statement-breakpoint

-- An ordered, deterministic, inspectable engine - no statistical model (§8.6).
--
-- `conditions` is jsonb and `category_id` is a column, which is not an
-- inconsistency: the conditions will grow - counterparty, kind, tags - and a
-- column per condition would be a migration each time, while the outcome is a
-- reference the database can enforce and cascade.
CREATE TABLE categorisation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households (id) ON DELETE CASCADE,

  -- What a person called it, so a list of rules reads as sentences.
  name text NOT NULL,

  -- Lower runs first. Not unique: two rules may share a priority, and refusing
  -- that would make adding one a renumbering exercise.
  priority integer NOT NULL DEFAULT 100,

  -- Validated on the way in and on the way out, because a row is input the
  -- moment anything reads it back.
  conditions jsonb NOT NULL,

  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,

  -- Whether a match ends the pass. Default true: the common case is one
  -- category per movement, and a rule that keeps going is the exception.
  stop_on_match boolean NOT NULL DEFAULT true,

  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX categorisation_rules_order ON categorisation_rules (household_id, priority, id);
--> statement-breakpoint

-- Which rule decided, or null when a person did.
--
-- What makes re-applying rules safe. Without it, a second pass either skips
-- everything already categorised - so editing a rule changes nothing - or
-- overwrites the choices somebody made by hand. With it, a pass touches what
-- rules decided and leaves people's own answers alone. It is also the honest
-- answer to "why is this in groceries".
ALTER TABLE entries ADD COLUMN categorised_by uuid
  REFERENCES categorisation_rules (id) ON DELETE SET NULL;
--> statement-breakpoint

-- Written by hand because drizzle-kit does not generate policies, and every
-- table carrying household data must have one (ADR-0007).
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;

CREATE POLICY categories_tenant ON categories
  USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint

ALTER TABLE categorisation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorisation_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY categorisation_rules_tenant ON categorisation_rules
  USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
