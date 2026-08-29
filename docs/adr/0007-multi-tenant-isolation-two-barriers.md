# ADR-0007 - Multi-tenant isolation: two barriers

- **Status:** accepted
- **Date:** 2026-08-30
- **Deciders:** @HugoB07

## Context

One household reading another's data is the worst bug this codebase can have. It is not
a degraded experience, it is the disclosure of somebody's complete financial position to
a stranger, and `SECURITY.md` names it the most serious class of finding for that reason.

A self-hosted instance usually holds one household, which makes the failure feel remote.
It is not: shared instances exist (a family running one server, a small group splitting
hosting), the schema supports several households from day one, and the code that would
leak between them is written now regardless of who deploys it.

The usual answer is to scope every query in the application. That works exactly as long
as nobody forgets. It is one `where` clause among many, it is invisible when missing, and
the query still returns rows - just the wrong ones. A code review catches it when the
reviewer is looking for it.

The other usual answer is to rely on PostgreSQL row-level security alone. That inverts
the failure: the filter is never forgotten, but it depends on a session variable that
_can_ be forgotten, and a connection with no variable set either sees everything or
nothing depending on how the policy is written.

Neither is sufficient alone. Both fail differently, which is what makes them worth
combining.

## Decision

**Two independent barriers. One of them failing must not be enough to leak data.**

### Barrier one: the application binds the work to a tenant

`withHousehold(client, ctx, work)` opens a transaction and declares the tenant on that
connection before the work runs:

```ts
await tx.execute(sql`SELECT set_config('app.current_household', ${ctx.householdId}, true)`);
```

Two details carry the weight. The third argument to `set_config` is `is_local`, which
gives `SET LOCAL` semantics: the setting is discarded at COMMIT or ROLLBACK, so a pooled
connection cannot carry one household's identity into the next request. A plain `SET`
would do exactly that, and the leak would only appear under concurrency, which is to say
in production and not in tests. And the id is a bind parameter rather than string
interpolation, so a crafted household id cannot become SQL.

In `apps/web`, `scoped()` is the only route from a request to household data, and it
takes no household argument. The tenant comes from the verified session and nowhere else.
A caller that could name the household would eventually name the wrong one.

### Barrier two: the database filters regardless

Row-level security on all eight household-scoped tables, with policies keyed on a
function rather than the raw setting:

```sql
CREATE OR REPLACE FUNCTION current_household() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.current_household', true), '')::uuid;
$$ LANGUAGE sql STABLE;
```

`current_setting(..., true)` returns NULL instead of raising when the setting is absent,
and `household_id = NULL` is NULL rather than true. A connection that forgot barrier one
therefore sees **nothing**. That direction is deliberate: the failure mode of a forgotten
scope is an empty screen, which someone reports, rather than another household's data,
which nobody does.

Policies are split by command. `USING` governs which rows may be read or targeted;
`WITH CHECK` governs what may be written. UPDATE carries both, so a row cannot be updated
out of its own household.

### Two roles, chosen at deployment

`altitude_app` serves every request and every background job. It is subject to row-level
security, which is the whole of the second barrier. A job spanning households iterates
them and calls `withHousehold` once each: slower than one unscoped query, and it means a
bug in the worker cannot leak across households either.

`altitude_migrate` holds BYPASSRLS and is for migrations, backups and maintenance only.

There is deliberately no option on the client to switch between them. The choice is made
once, in the connection string, by whoever deploys - not per call site, where "just this
once" eventually means everywhere.

### One narrow exception, and it is not an exemption

Sign-in has a chicken-and-egg problem: the one question that cannot be asked from inside
a household is which households you belong to. `withUser` sets only `app.current_user`,
and migration 0004 adds two SELECT policies - your own membership rows, and the
households those rows name. PostgreSQL combines permissive policies with OR, so this
opens exactly one extra path and leaves every household filter in place for everything
else. Nothing is exempted; a second, narrower key is added.

### The services check that the two agree

`assertCan(actor, action, { householdId: actor.householdId })` compares the actor's
household to itself. It checks the role and nothing about tenancy, which is easy to
misread as a tenancy check because of its shape. So each service also asserts that the
connection's tenant matches the actor:

```ts
if (tenant === '') throw new TenantScopeError('This work is not bound to a household.');
if (tenant !== actor.householdId) throw new TenantScopeError(/* ... */);
```

Row-level security would return the right rows either way, so nothing would look wrong.
The caller would simply be acting for a household it did not intend.

### The process refuses to start unscoped

`assertTenantScopingActive` runs on the first request and rejects a role that is a
superuser, has BYPASSRLS, or owns the tables while FORCE is off.

### The escape hatch is fenced

`Client.unsafe` is the raw handle, bound to no household, and reaching household data
through it skips barrier one while looking entirely normal: the query succeeds and
returns rows from every household.

`packages/db/test/unsafe-handle.test.ts` scans the source and fails on any read of
`.unsafe` outside an explicit allow list. Two entries are on it: `packages/db/src`, which
defines the handle and the functions that bind it, and `apps/web/src/server/auth.ts`,
because Better Auth's tables carry no household of their own and its adapter therefore
cannot be tenant-scoped. Test files are exempt, since proving the barrier holds means
reaching past it on purpose.

A source scan is crude. It is also what CI runs, which makes it the enforcement that
exists rather than the one planned - the same trade already made for the secrets guard in
`packages/shared/test/env.test.ts`. The pattern it matches distinguishes a property read
from postgres.js's unrelated `sql.unsafe(query)` by the call parenthesis, and that
distinction is itself asserted in the test rather than assumed.

## Three ways this was found broken while building it

Worth recording, because each one left every observable signal saying the barrier was
present.

**The owner exemption.** `ENABLE ROW LEVEL SECURITY` does not apply to the role that owns
the tables; PostgreSQL exempts owners by default. Nothing errors, `pg_class` still reports
`relrowsecurity = true`, and every policy is listed in `pg_policies`. The barrier looks
present in every place someone would think to check and passes no rows through a filter.
Closed by `FORCE ROW LEVEL SECURITY` in migration 0002.

**The superuser.** FORCE does not reach a superuser either, so migration 0002 buys nothing
against one. This is not hypothetical: the role a Postgres image creates from
`POSTGRES_USER` is a superuser, so the obvious `DATABASE_URL` - the one docker-compose
hands out - lands exactly there. No amount of SQL fixes it, which is why the runtime check
exists and why `.env.example` points at `altitude_app`. A test asserts the _inverse_, that
a superuser does see both households, so deleting the startup check breaks a test rather
than silently removing the guard.

**Write-side policies missing.** The policies in 0001 were `USING`-only, which governs
reads. Under FORCE that left INSERT unguarded: a row could be written into another
household and then become invisible to its author. Closed by `WITH CHECK` in 0002.

All three were found by running the thing, not by reading it.

## Alternatives considered

| Option                   | Why it was rejected                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application scoping only | One forgotten `where` clause leaks, silently, with rows returned rather than an error. Nothing about the omission is visible in review unless the reviewer is looking for it.                                           |
| Row-level security only  | Never forgotten, but every query depends on a session variable that can be, and the service layer would have no way to notice it was acting for the wrong household. Also leaves nothing to catch a misconfigured role. |
| A schema per household   | Genuinely strong isolation, and it makes cross-household reporting, migrations and connection pooling all significantly harder for a deployment that usually holds one household.                                       |
| A database per household | Stronger still, and incompatible with a self-hoster running this on a NAS. Backups multiply, migrations multiply, and ADR-0001 exists to keep the operational surface at one service.                                   |

## Consequences

**Easier.** A leak needs two independent failures. The scoping bugs actually written
during phase 0 produced empty results, not other households' data.

**Easier.** A misconfigured `DATABASE_URL` fails at boot with a sentence naming the
problem, rather than at the first cross-tenant read.

**Harder.** Every unit of work is a transaction, including single reads. Background jobs
that span households loop instead of issuing one query.

**Harder.** Tests need a non-superuser role, so the suite creates `altitude_app` and runs
the migrations against a Testcontainers instance rather than using the image's default
user.

**Accepted.** Tables with no household of their own - instrument prices, FX rates, and
the Better Auth tables - carry no tenant policy. They hold no household data by
construction, and that has to stay true as the schema grows.

## Revisit if

- A table gains household data without gaining a policy. The policy list in migrations
  0001, 0002 and 0004 is the checklist; nothing yet fails a build when a new table is
  missing from it.
- Connection pooling moves to a transaction-pooling proxy such as PgBouncer. `SET LOCAL`
  is safe there, but only because every unit of work is already a transaction. That
  assumption becomes load-bearing rather than incidental.
- Sharing beyond a household appears - a read-only link, an adviser's access. Those need
  a third key, and adding it as another permissive policy deserves its own decision.
