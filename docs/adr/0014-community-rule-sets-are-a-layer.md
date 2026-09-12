# ADR-0014 - Community rule sets are a layer, not rows copied into a household

- **Status:** accepted
- **Date:** 2026-09-12
- **Deciders:** @HugoB07

## Context

Categorisation is a deterministic ordered engine with no statistical model (§8.6), which
means a household starts with an empty list of rules and categorises nothing until
somebody writes one. A first import is a blank slate, and the work of filling it is the
same work for every French household: Carrefour is groceries, EDF is energy, Urssaf is
tax.

The plan answers this in one clause: "user rules first, then a community rule set per
country, versioned in the repository" (§8.6). It says the order and it says where the set
lives. It does not say what happens to the set once a household turns it on, and the two
readings of that are genuinely different systems.

Copying is the obvious one: turning on the French set inserts sixty-two rows into the
household's own rules, where they are ordinary rules a person can edit. It is simple, it
needs no new concept, and every screen already knows how to show it.

It is also a one-way door. The rows are in a household's data from the moment they are
copied, so improving a shipped pattern helps nobody who already turned it on - and there
is no way to tell a row somebody edited from a row that arrived by copy, so an update
cannot safely touch either. Sixty-two rows become sixty-two rows per household, per
country, forever, and every one of them is a row a migration has to reason about without
knowing where it came from.

## Decision

A rule set stays a file in the repository and is read at categorisation time. A household
stores which set it uses - one column, `households.rule_set` - and nothing else.

The sets run **under** a household's own rules, and they only fill what those left empty.
A household rule that names a category wins; a shipped rule may still supply the
counterparty the household rule did not. Nothing shipped ever overrides a decision
somebody made for themselves.

Where a category comes from is recorded per entry, and separately:
`entries.categorised_by` for a household's own rule, `entries.categorised_by_set` for a
shipped one. Two columns rather than one, because the two ids live in different
namespaces and a single column could not say which it held.

A shipped rule names a category by key, not by row. `categories.key` resolves the key
against the household's own categories, which is what lets one file serve a French
household and an English one: the name is written in the reader's language on the
application's side of the boundary. A key with no row categorises nothing and still
names the shop, rather than failing.

## Alternatives considered

| Option                                               | Why it was rejected                                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy the rules into the household on activation      | Improving a shipped pattern reaches nobody who already activated it, and an edited copy is indistinguishable from an untouched one - so an update can neither skip the first nor apply to the second. |
| Copy them, and keep a marker saying which are copies | Solves the update, and leaves every household carrying sixty-two rows of data it did not write, per country, which every later migration has to carry with it.                                        |
| Ship no sets; let people write their own             | The plan's own answer to a blank first import, and it asks every household in France to do the same afternoon of work.                                                                                |
| One set, not per country                             | The patterns are national - the shops, the utilities, the tax authority - and a set that tried to cover everywhere would be wrong everywhere.                                                         |

## Consequences

A shipped set improves for everyone at once, in a release, with no migration: the file
changes and the next categorisation run reads the new file. That is the whole reason.

A person cannot edit a shipped rule. They can write their own above it, which wins, and
that is the intended escape - but "fix this one pattern" is not a button, and somebody
will want it.

The engine has to carry the distinction. `categorise` takes rules with a `source`, and a
rule from a set fills rather than overrides; `Categorised` reports `ruleSource` so the
answer to "why is this in groceries" can name which half decided. That is a real cost in
a function whose whole virtue is being simple enough to reason about.

A set is data in the repository and is therefore reviewed like data: `parseRuleSet`
refuses an unknown field, an uncompilable pattern, a category key the application cannot
name, a duplicate id, and a rule with no condition. A bad rule shipped here is wrong for
everybody at once, and for people who did not choose it, so the bar is higher than for a
rule somebody writes for themselves.

The two columns are written and not yet displayed. "Why is this in groceries" has an
answer in the database and not on a screen, which is a gap this decision created and has
not closed.

## Revisit if

Households start needing to edit shipped rules often enough that writing one above them
stops feeling like the answer. The shape that would follow is an override table - a
household row that disables or amends one shipped rule by id - which keeps the file
authoritative and is a smaller change than copying.
