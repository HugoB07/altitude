-- A dictionary of things that can be held. Not a price engine.
--
-- It exists because a purchase cannot be recorded without it: a buy is two
-- entries summing to zero - cash out, holding in - and the holding line carries
-- a quantity, which the ledger refuses without an instrument to attach it to.
-- Importing a broker export without this table would mean inventing a
-- "securities" account that receives value in bulk, and later re-deriving real
-- positions from text nobody meant to be parsed.
--
-- Outside every household, and so with no household_id and no RLS policy. That
-- is correct rather than an oversight: an ISIN means the same thing to
-- everyone, and knowing FR0011550193 exists says nothing about who owns it -
-- that lives in `entries`, which is scoped. Duplicating the row per household
-- would store one fact many times and let the copies drift.
--
-- The unique index covers only the rows that have an ISIN. Plenty of holdings
-- have none - crypto, unlisted shares, a stake in a company - and those must
-- not be forced to invent one.
--
-- Nothing here is a price, a valuation or a provider identifier. See ADR-0011.

CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"isin" text,
	"symbol" text,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_isin_key" ON "instruments" USING btree ("isin") WHERE "instruments"."isin" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "instruments_symbol_idx" ON "instruments" USING btree ("symbol");--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
