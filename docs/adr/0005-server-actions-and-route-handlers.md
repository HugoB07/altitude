# ADR-0005 - Server Actions for internal mutations, Route Handlers for the API

- **Status:** accepted
- **Date:** 2026-08-30
- **Deciders:** @HugoB07

## Context

The App Router offers two ways to run server code in response to a request, and they
are not interchangeable:

- A **Server Action** is called by reference from a component. Next generates the
  endpoint, the framework serialises the arguments, and a form submits to it without
  JavaScript. There is no stable URL, no documented request shape, and nothing outside
  this application can call it.
- A **Route Handler** is a real HTTP endpoint at a real path, with the request and
  response objects in hand. It can be called by anything that speaks HTTP.

Picking one for everything is the wrong instinct in both directions. Server Actions for
the public API would mean a contract nobody outside Next can consume. Route Handlers for
every form would mean hand-writing fetch calls, error handling and pending states that
the framework already provides, and losing progressive enhancement.

The real risk is neither. It is that logic settles into whichever transport happens to be
there. A balance computed inside a Server Action cannot be reached by the import
pipeline, the background worker or a test that does not fake a request, so the second
caller reimplements it, and the two drift. In a double-entry ledger, two implementations
of the same rule is the bug that produces two different net worths for one household.

## Decision

**The transport is chosen by who calls it.**

| Caller                                      | Mechanism     |
| ------------------------------------------- | ------------- |
| Altitude's own interface, submitting a form | Server Action |
| Anything with an external consumer          | Route Handler |

"External consumer" means Better Auth's client library, the public read API, connector
callbacks, webhooks, file downloads, and anything a user might reasonably call with
`curl`. `apps/web/src/app/api/auth/[...all]/route.ts` is the first of them: those paths
are a contract the Better Auth client calls by URL, not a form submission.

**Neither one implements anything.** Both call `packages/core/services`, which is where
mutations actually live. A service:

- takes a `Database` transaction handle rather than opening one, so the tenant binding
  stays at the edge where the session is (ADR-0007);
- performs its own authorisation, so the check cannot be skipped by adding a caller;
- knows nothing about `FormData`, `Request`, cookies, redirects or locales.

**What a Server Action may contain**, and nothing else: read the form, coerce and
validate its fields, call one service function, and turn the outcome into a redirect, a
revalidation, or a message the form can display. Parsing input is transport work and
belongs here. Anything that computes money, decides a permission, or knows a ledger rule
does not.

That is the review rule, and it is deliberately not a line count. `quickAddAction` runs
past forty lines and is correct: the length is field validation and a comma-to-point
substitution for French keyboards, all of it transport. A shorter action that reached
into the ledger would be the one to reject.

## Alternatives considered

| Option                                        | Why it was rejected                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route Handlers for everything, actions unused | Uniform, and every form becomes hand-written fetch plus error plus pending state. Loses progressive enhancement, which for a self-hosted app on a slow connection is a real feature rather than a checkbox.    |
| Server Actions for everything, including sync | No stable URL and no documented request shape, so nothing outside the application could ever integrate. Also ties a public contract to a framework internal that Next has already changed once.                |
| A tRPC or similar RPC layer                   | Solves a typing problem the service layer already solves, at the cost of a dependency between the domain and a transport library. `packages/core` must keep working with no browser, no server and no network. |
| Logic in the action, no service layer         | The shortest path to the first screen, and the reason the import pipeline would later reimplement transaction posting. Ruled out in advance rather than after it happened.                                     |

## Consequences

**Easier.** A mutation is testable without a request: `postTransaction(tx, actor, input)`
is called directly by the integration tests. The worker and a future CLI reach the same
function, so there is exactly one implementation of every rule.

**Easier.** Where a mutation lives is predictable. Looking for how a transaction is
posted means looking in `packages/core/src/services`, never in a page.

**Harder.** Every mutation is two files instead of one, which feels like ceremony at
three screens. It stops feeling like ceremony at the second caller.

**Accepted.** Server Actions have no stable URL, so nothing internal can be integration
tested over HTTP. The service beneath is tested instead, and the action is thin enough
that the untested part is form parsing.

**Accepted.** Authorisation living in the service means it runs on every path, including
ones that already know the answer. That is the point: a check that can be skipped by
forgetting an `if` is not a check.

## Revisit if

- A mobile or desktop client appears. It cannot call Server Actions, so every internal
  mutation would need a Route Handler counterpart, and the split above becomes a
  duplication rather than a boundary.
- Next changes Server Actions again in a way that breaks progressive enhancement, which
  is most of why they are here.
