-- A description of a bank's file, kept so it is written once.
--
-- Scoped to a household, and that is a decision rather than a default. A
-- mapping holds no figures - it says "this file's third column is the amount" -
-- but its existence says which bank somebody uses. `instruments` accepts that
-- kind of leak because phase 3 seeds it with a public catalogue that dissolves
-- it (ADR-0011); nothing will ever dissolve this one, since the table would
-- only ever hold what people actually imported.
--
-- Sharing happens through the repository instead: a mapping worth having by
-- everyone ships as a preset, which is a file in git rather than a row here.
CREATE TABLE imports_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households (id) ON DELETE CASCADE,

  -- What the person called it, so a list of them is readable.
  name text NOT NULL,

  -- The header row and the delimiter, which is what two exports of the same
  -- bank agree on and everything else differs by. Unique per household: a
  -- second description of the same shape is a correction, not an addition.
  fingerprint text NOT NULL,

  -- The `ColumnMapping` itself. Validated on the way in and on the way out,
  -- because a row is input the moment anything reads it back.
  mapping jsonb NOT NULL,

  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX imports_mappings_fingerprint_key
    ON imports_mappings (household_id, fingerprint);

-- Written by hand because drizzle-kit does not generate policies, and every
-- table carrying household data must have one (ADR-0007). The guard in
-- tenant-scope.test.ts finds this table by its household_id column, so
-- forgetting this block fails the suite rather than shipping.
ALTER TABLE imports_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY imports_mappings_tenant ON imports_mappings
  USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
