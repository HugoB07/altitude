# ADR-0011 - Instruments are a shared dictionary, not a price engine

- **Status:** accepted
- **Date:** 2026-09-01
- **Deciders:** Hugo

## Context

Phase 2 imports a broker export, and a purchase cannot be recorded without somewhere to
put what was bought. A buy is two entries summing to zero - cash out, holding in - and
the holding line carries a quantity, which the ledger refuses unless an instrument is
attached to it (`InconsistentHoldingError`, ADR-0002).

So a table had to exist before phase 3, which is where quotes, valuation and performance
belong. The risk of building it early is building it wrong: a table created to satisfy an
import will grow a `last_price` column the first time a screen wants to show one, and
then a `price_updated_at`, and then a provider identifier - and phase 3 arrives to find
the shape of its own domain already decided by whoever was in a hurry.

The alternative to building it at all was to import a purchase as value moving into a
"securities" account in bulk. That records the money and loses the holding: the quantity,
the instrument and the unit price all become text in a description, to be re-derived
later from something nobody meant to parse.

## Decision

`instruments` is a dictionary of things that can be held. It carries what identifies an
instrument and nothing about what it is worth.

The table holds an ISIN where one exists, a symbol, a name, a currency of denomination
and a coarse kind. It holds no price, no valuation, no quantity, and no provider
identifier. Quantities live in `entries`, which is where the ledger keeps them.

It sits outside every household, with no `household_id` and no row-level security policy.
An ISIN means the same thing to everyone; a row per household would be the same fact
stored many times, free to drift.

## Alternatives considered

| Option                                         | Why it was rejected                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No table; holdings as value in a bulk account  | Records the money and loses the holding. The quantity and the instrument survive only as text in a description, and phase 3 would have to reconstruct positions from it.                             |
| One instruments table per household            | Duplicates reference data that is identical everywhere and lets the copies disagree. It also makes seeding a catalogue in phase 3 a per-household operation.                                         |
| Build it with prices now                       | Decides the shape of phase 3's domain in a phase that only needs a name and an ISIN. A cache written before its queries is a cache written twice (the same argument that moved ADR-0008 to phase 3). |
| Key holdings on the ISIN string, with no table | Works until a holding has no ISIN - crypto, unlisted shares, a stake in a company - which is exactly the case a wealth tracker cannot drop.                                                          |

## Consequences

An import can record a purchase completely: cash out, holding in, with the quantity and
unit price the file gave, and the instrument resolved or created. Nothing is re-derived
later.

Matching is on the ISIN where there is one, and on the name otherwise. The fallback is
weaker - two brokers spell the same fund differently - so an import of unlisted holdings
will eventually need a person to say "these two are the same thing". That merge screen
does not exist and is not needed until somebody holds two.

The table being outside every household has a cost, and it is named rather than left
implicit: on an instance shared by two households, `instruments` is the union of what
both hold, so a member of one can learn that somebody here owns a particular ETF. Not
who, and not how much - that is in `entries`, which is scoped - but the row's existence
is evidence.

That is accepted because phase 3 seeds this table with a catalogue of known ISINs for
quotes to hang off. Once a row's presence no longer implies anyone owns it, there is
nothing left to infer. Scoping the table per household would trade a small leak for
duplicated reference data that drifts, which is worse.

The guard that every table holding household data has RLS enabled, forced and policied
(`packages/db/test/tenant-scope.test.ts`) does not need to be told about this table, and
that is worth stating because the obvious implementation would have. It selects the
tables carrying a `household_id` column rather than working from a list of exceptions -
so `instruments` is out of scope for the reason it is out of scope, and the day somebody
adds household data here the guard starts demanding a policy without anybody remembering
to update it.

## Revisit if

An instance is shared by households that do not know each other and the union of their
holdings becomes something one of them objects to - a public instance, rather than a
family or a couple. Or if phase 3 finds that a quote needs to be scoped after all,
because two households value the same instrument differently.
