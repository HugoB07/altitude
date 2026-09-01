# ADR-0012 - An account holds one currency, and entries must match it

- **Status:** accepted
- **Date:** 2026-09-01
- **Deciders:** Hugo

## Context

A household chooses a base currency when it is created. Until phase 2 nothing read it
back: the dashboard and the accounts page wrote `'EUR'` in their source, so a household
set up in Swiss francs held three accounts in francs, matched no account when net worth
filtered by currency, and reported zero for ever without a word.

Fixing that exposed something worse. Double entry balances **per currency** (ADR-0002),
so two euro entries balance each other whatever accounts they name. Nothing compared an
entry's currency to its account's, and `accountBalances` sums `amount` without reading
`currency`, labelling the total with the account's own. A dollar account full of euro
entries therefore reported a dollar balance that was really a pile of euros. This was
reported from a real import, where an account read "400.79 $US" and held none.

None of it failed. Every step was accepted, every invariant held, and the number on the
screen was wrong.

Converting was not available. A rate belongs to a day and has to be recorded with the
transaction that used it, which is phase 3 (ADR-0008's neighbour in the same phase).
Inventing one at write time would replace a refusal somebody can see with an
approximation nobody can.

## Decision

An account is denominated in one currency, fixed when it is created, and an entry may
only move the currency its account holds. `postTransaction` refuses anything else by
name - the account, the currency it holds, and the currency of the entry.

Totals cover the household's own currency. Accounts in another are excluded from them and
**named underneath**, because a total that quietly omits an account looks exactly like a
total that is right.

A transfer between accounts in different currencies is refused rather than converted. The
refusal comes from the domain, not from a second check in the web layer, so there is one
wording of the rule and it cannot drift.

## Alternatives considered

| Option                                       | Why it was rejected                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convert at write time using a current rate   | A rate belongs to a day and has to be stored with the transaction to be checkable later. Fetching one at write time buries an approximation in the ledger, where nothing distinguishes it from a figure a person entered. |
| Allow mixed currencies and sum per currency  | `accountBalances` would return several balances per account, and every screen showing "a balance" would have to choose one. It also makes "what is this account worth" a question with no single answer.                  |
| Let a bare `Money` mismatch throw as it does | It already did, in `Money.plus` - which is why a single foreign account did not merely mislead the accounts page, it took the page down. Throwing at display time is far too late.                                        |
| Allow the currency of an account to change   | An account with entries in it cannot change currency without rewriting them, which is what an append-only ledger exists to prevent (ADR-0002). Opening another account is the correct move and costs nothing.             |

## Consequences

An account in another currency is holdable, visible, and excluded from totals with an
explanation. That is honest and incomplete: somebody with a dollar account sees it, sees
its balance in dollars, and sees that it is not in their net worth.

An import creates its accounts in the currency the file mostly moves, and a securities
label follows its cash account - a euro CTO is not denominated by the first American
share bought in it. Where a file mixes currencies on one account, the entries that do not
match are refused when posted rather than added to a total they do not belong in.

The currency of an account cannot be changed. Nothing in the application offers it, and
the way out of a wrong choice is to reverse what is in the account, close it, and open
another. That is more friction than a settings field, and it is the friction that keeps
the ledger true.

`Money` mismatches now surface at the boundary rather than at render time, which is what
makes a wrong currency a refusal with a sentence rather than a page that fails to load.

## Revisit if

Phase 3 lands dated rates per account. At that point a total can include a foreign
account by converting it at a rate stored with the figure, and the exclusion above
becomes a fallback for accounts with no rate rather than the rule.
