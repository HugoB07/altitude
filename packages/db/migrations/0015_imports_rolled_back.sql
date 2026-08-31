-- An import that has been undone says so.
--
-- The reversals themselves are the truth: every transaction the run made has an
-- opposite, and the ledger stays append-only (ADR-0002). This column is the
-- answer to "has this already been undone?", which is otherwise a count of
-- transactions and their reversals every time the list is drawn - and which two
-- people pressing the button at the same moment could both get wrong.
--
-- Nullable rather than a boolean: when it happened is worth as much as whether,
-- and a null is unambiguous where `false` and "not yet migrated" are not.
ALTER TABLE imports ADD COLUMN rolled_back_at timestamptz;
ALTER TABLE imports ADD COLUMN rolled_back_by uuid REFERENCES users (id) ON DELETE SET NULL;
