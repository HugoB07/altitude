-- Three account classes, replacing a boolean that had to carry three states.
--
-- `is_liability` forced every account to be either an asset or a debt. The
-- opening balance account is neither: it is the counterpart that makes a first
-- deposit sum to zero (ADR-0002), and it was typed `other_liability` purely so
-- that net worth would skip it.
--
-- That worked by making the dashboard exclude every liability, which would have
-- excluded real debt too. Nobody would have noticed until the first mortgage,
-- and the symptom - net worth too high by exactly the loan - is the kind a user
-- is pleased to see rather than one they report.
--
-- Generated from `kind`, like the boolean it replaces, so a classification and
-- the kind it comes from cannot disagree.

ALTER TABLE "accounts" ADD COLUMN "classification" text GENERATED ALWAYS AS (CASE
          WHEN kind IN ('loan', 'credit_card', 'other_liability') THEN 'liability'
          WHEN kind IN ('opening_balance') THEN 'equity'
          ELSE 'asset'
        END) STORED NOT NULL;

--> statement-breakpoint

-- Reclassify the opening accounts that already exist.
--
-- Every `other_liability` row in any database today is an opening balance
-- account. That is not a guess: createHousehold is the only code path that
-- inserts into accounts, there is no interface for creating one, and it is the
-- only kind it writes. The predicate stops being exact the moment account
-- management ships, which is why this runs now.
UPDATE accounts SET kind = 'opening_balance' WHERE kind = 'other_liability';
