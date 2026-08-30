-- One run of an import, so that undoing it means something.
--
-- `import:rollback` has been in the authorisation policy since day one with
-- nothing behind it. This is what it needed: a name for the set of transactions
-- one file produced. Without it, undoing an import means finding its rows by
-- date and hoping nothing else was recorded that day.

CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"source" text NOT NULL,
	"filename" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imports_household_idx" ON "imports" USING btree ("household_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- Row-level security, which drizzle-kit does not generate and which this table
-- needs as much as any other. It carries household_id, so it carries household
-- data: who imported what, from which file, and when. A table with a tenant
-- column and no policy is readable by every tenant, and nothing about that is
-- visible from the application side (ADR-0007).
ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY household_isolation ON imports
  USING (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_write ON imports
  FOR INSERT WITH CHECK (household_id = current_household());
--> statement-breakpoint
CREATE POLICY household_update ON imports
  FOR UPDATE USING (household_id = current_household())
  WITH CHECK (household_id = current_household());
