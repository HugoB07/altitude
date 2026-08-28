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
GRANT USAGE, CREATE ON SCHEMA public TO altitude_migrate;
GRANT USAGE ON SCHEMA public TO altitude_app;
