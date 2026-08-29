-- Extensions required by the schema. Created here so a fresh dev database is
-- usable immediately; production installs them through a migration instead.
--
-- ltree      portfolio tree, subtree queries in one operation   (plan §5.3)
-- pgcrypto   gen_random_uuid(), and digest() for dedupe hashes  (plan §8.5)
-- btree_gist ownership shares without overlapping date ranges   (plan §5.4)
-- pg_trgm    fuzzy matching on transaction descriptions         (plan §8.5)
-- unaccent   accent-insensitive search on French descriptions

CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Two roles, per ADR-0007: the application is subject to row-level security,
-- the migration role bypasses it. Created here so the split exists from day one
-- rather than being retrofitted once RLS lands.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'altitude_app') THEN
    CREATE ROLE altitude_app LOGIN PASSWORD 'altitude_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'altitude_migrate') THEN
    CREATE ROLE altitude_migrate LOGIN PASSWORD 'altitude_migrate' BYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE altitude TO altitude_app, altitude_migrate;

-- CREATE on the database, not merely on schema public: drizzle-kit keeps its
-- ledger of applied migrations in a schema of its own and creates it on first
-- run. Without this the migrator fails while creating that schema, and reports
-- it as "undefined" - an error with no message, on a fresh database, which is
-- an unpleasant way to spend an evening.
GRANT CREATE ON DATABASE altitude TO altitude_migrate;
GRANT USAGE ON SCHEMA public TO altitude_app;

-- altitude_migrate owns the schema, so every table a migration creates belongs
-- to it and later migrations can ALTER them. Bootstrapping as the superuser
-- instead leaves the tables owned by a role the migration role cannot touch:
-- the first ALTER TABLE fails with "must be owner of table", and only on the
-- migration that needs it - long after the setup looked correct.
ALTER SCHEMA public OWNER TO altitude_migrate;
GRANT USAGE, CREATE ON SCHEMA public TO altitude_migrate;
