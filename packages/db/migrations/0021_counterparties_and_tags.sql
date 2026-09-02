-- Who was on the other side, and the labels that cut across categories.
--
-- Three things a movement can carry, and they answer different questions.
-- A category is exclusive - one per entry - so the categories sum to the total
-- and a breakdown is honest. A counterparty is a name: "how much at Carrefour
-- this year", which no category answers because groceries mixes every shop. A
-- tag is neither: a movement has none, one or five, and the tags do not sum to
-- anything. That is the point of having both - a week in Spain is restaurants
-- and fuel and a hotel, and turning it into a category would lose all three.
--
-- `transactions.counterparty` has been in the schema since the first migration
-- with nothing writing it. Now the import reads it where a bank gives it, and
-- a rule sets it where none does.

-- Tags belong to the transaction, not the entry.
--
-- A category sits on the entry so one expense can be split across three of
-- them. A tag qualifies the movement as a whole: "spain-2026" is not a share
-- of anything, and putting it on each side would double every count.
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tags_name_key ON tags (household_id, lower(name));
--> statement-breakpoint

CREATE TABLE transactions_tags (
  transaction_id uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, tag_id)
);

-- Leading with household_id because every query runs under row-level security,
-- which adds that predicate: an index without it cannot answer on its own and
-- sends PostgreSQL back to the heap to check. Same reason as
-- `entries_account_idx`, measured there at 1,912 ms against 433 ms.
CREATE INDEX transactions_tags_lookup
    ON transactions_tags (household_id, tag_id, transaction_id);
--> statement-breakpoint

-- A rule may set a counterparty, a category, tags, or any mix of them.
--
-- `category_id` therefore stops being mandatory. What stops a rule with no
-- effect at all is `createRule`, not a constraint: the tags live in another
-- table, so a CHECK could only see two thirds of the question and would refuse
-- a rule that only tags - which is a perfectly good rule.
ALTER TABLE categorisation_rules ADD COLUMN counterparty text;
ALTER TABLE categorisation_rules ALTER COLUMN category_id DROP NOT NULL;
--> statement-breakpoint

CREATE TABLE categorisation_rule_tags (
  rule_id uuid NOT NULL REFERENCES categorisation_rules (id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, tag_id)
);
--> statement-breakpoint

-- The filters these exist to make possible.
--
-- Both follow the shape the existing ones use. The counterparty one mirrors
-- `transactions_household_kind_idx`: household, the filtered column, then the
-- ordering pair, so matching rows come back sorted without a sort step and the
-- page is an index-only scan. Partial, because most rows have no counterparty
-- and an index over those nulls is size nobody reads.
CREATE INDEX transactions_household_counterparty_idx
    ON transactions (household_id, counterparty, booked_on DESC, id DESC)
    WHERE counterparty IS NOT NULL;

-- The category filter is an EXISTS over entries, like the account filter, so
-- it wants the same index shape that one has.
CREATE INDEX entries_category_idx
    ON entries (household_id, category_id, transaction_id)
    WHERE category_id IS NOT NULL;
--> statement-breakpoint

-- Written by hand because drizzle-kit does not generate policies, and every
-- table carrying household data must have one (ADR-0007).
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
CREATE POLICY tags_tenant ON tags
  USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint

ALTER TABLE transactions_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY transactions_tags_tenant ON transactions_tags
  USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
--> statement-breakpoint

ALTER TABLE categorisation_rule_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorisation_rule_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY categorisation_rule_tags_tenant ON categorisation_rule_tags
  USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
