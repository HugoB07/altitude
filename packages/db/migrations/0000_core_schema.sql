-- Extensions first: the schema below declares an ltree column and a
-- gen_random_uuid() default, so neither table can be created without them.
-- Kept at the head of the generated migration rather than in a separate one,
-- because drizzle-kit regenerates from a snapshot that does not model
-- extensions and would order a standalone migration after this file.
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"birth_date" date,
	"user_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"subtype" text,
	"currency" text NOT NULL,
	"institution" text,
	"external_ref_enc" text,
	"external_ref_last4" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_liability" boolean GENERATED ALWAYS AS (kind IN ('loan', 'credit_card', 'other_liability')) STORED NOT NULL,
	"opened_on" date,
	"closed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"share" numeric(9, 6) NOT NULL,
	"right_type" text DEFAULT 'full' NOT NULL,
	"valid_from" date DEFAULT '-infinity' NOT NULL,
	"valid_to" date DEFAULT 'infinity' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" "ltree" NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"color" text,
	"target_alloc" jsonb,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(28, 10) NOT NULL,
	"currency" text NOT NULL,
	"instrument_id" uuid,
	"quantity" numeric(38, 18),
	"unit_price" numeric(24, 12),
	"fx_rate_to_base" numeric(24, 12),
	"category_id" uuid,
	"memo" text
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"booked_on" date NOT NULL,
	"value_on" date,
	"kind" text NOT NULL,
	"description" text,
	"counterparty" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"dedupe_hash" text,
	"reverses_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_household_idx" ON "memberships" USING btree ("household_id","user_id");--> statement-breakpoint
CREATE INDEX "owners_household_idx" ON "owners" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "accounts_household_idx" ON "accounts" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "accounts_portfolio_idx" ON "accounts" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "ownerships_account_idx" ON "ownerships" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolios_household_path_key" ON "portfolios" USING btree ("household_id","path");--> statement-breakpoint
CREATE INDEX "portfolios_household_idx" ON "portfolios" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "entries_account_idx" ON "entries" USING btree ("account_id","transaction_id");--> statement-breakpoint
CREATE INDEX "entries_transaction_idx" ON "entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_external_id_key" ON "transactions" USING btree ("household_id","external_id") WHERE "transactions"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transactions_household_booked_idx" ON "transactions" USING btree ("household_id","booked_on" DESC NULLS LAST);