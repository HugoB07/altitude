# ADR-0001 — PostgreSQL as the only datastore

- **Status:** accepted
- **Date:** 2026-08-28
- **Deciders:** @HugoB07

## Context

Altitude needs a transactional store, a background job queue, an application cache,
lightweight text search, and daily time series for valuation history. The reflex is to
reach for a specialised tool per role — Postgres plus Redis plus a columnar store.

The deployment target rules that out. Altitude is self-hosted, and a large share of its
users will run it on a NAS, a Raspberry Pi, or a small VPS. Every additional service is
a container to run, a port to secure, a backup to keep consistent with the others, and
one more way for a restore to come back subtly wrong.

Scale is modest by design: a household, occasionally a small group. Ten years of history
for twenty accounts is a few hundred thousand rows. Quote series dominate storage and
still stay under a couple of million rows.

## Decision

**PostgreSQL 17 is the only data dependency.** It fills all five roles:

| Role                | Mechanism                                                     |
| ------------------- | ------------------------------------------------------------- |
| Transactional store | Tables, constraints, deferred triggers                        |
| Job queue           | `pg-boss` (`SKIP LOCKED`)                                     |
| Cache               | Ordinary tables, `UNLOGGED` where durability is not needed    |
| Search              | `pg_trgm` + `unaccent` over descriptions and instrument names |
| Time series         | Range-partitioned tables with BRIN indexes                    |

Extensions enabled: `pgcrypto`, `ltree`, `btree_gist`, `pg_trgm`, `unaccent`.

Redis remains _possible_ for large deployments but is never _required_, and no feature
may depend on its presence.

## Alternatives considered

| Option                      | Why it was rejected                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite                      | Attractive for single-user self-hosting, but no row-level security, a weak concurrent-writer story, and `NUMERIC` is not exact — disqualifying for money (development plan, ADR-006). |
| Postgres + Redis            | Redis is the better queue and cache, but it doubles the operational surface for every self-hoster to serve a load none of them will reach. Kept as an option, never a requirement.    |
| MongoDB                     | No natural multi-document transaction model for a double-entry ledger, and no exact decimal arithmetic.                                                                               |
| Postgres + a columnar store | Justified above roughly 50M quote rows. No instance will approach that for years.                                                                                                     |

## Consequences

**Easier.** The compose file is four services. A backup is one `pg_dump` plus the file
volume, so a restore cannot land in a state where two stores disagree. Integration tests
run against a single Testcontainers image.

**Harder.** The job queue tops out around a few thousand tasks per minute — far beyond a
household, but it is a real ceiling. Cache invalidation runs through SQL rather than
Redis TTLs. Heavy analytical queries compete with transactional load on one instance.

**Accepted.** Postgres is a required, non-optional dependency. There is no "just run the
binary with SQLite" mode, and adding one later would mean maintaining two schema dialects
and losing RLS.

## Revisit if

A single instance exceeds ~500 active users, or quote history passes ~50M rows and
dashboard queries breach the 300 ms p95 budget from §6.5 of the development plan.
