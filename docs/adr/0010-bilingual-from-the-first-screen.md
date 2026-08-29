# ADR-0010 - Bilingual from the first screen, no locale in the URL

- **Status:** accepted
- **Date:** 2026-08-29
- **Deciders:** @HugoB07

## Context

Altitude targets French households first. The wrappers that make it worth building at
all - PEA, assurance-vie, PER - exist nowhere else, and the bank-synchronisation analysis
(`docs/plan/`, §7) concluded that a French user's wealth is mostly outside PSD2's reach.
Meanwhile the repository, the ADRs and the contribution process are in English, because
that is the language an open-source project is read in.

So the application needs both languages, and the question is only _when_.

The honest answer is now, at three screens. Every string hardcoded today is a diff
tomorrow, and retrofitting i18n is the kind of change that touches every file while
delivering nothing visible - exactly the work that never gets scheduled. Adding it at
three pages costs an afternoon; adding it at forty costs a sprint and misses strings.

The plan had it in phase 6, next to export and backup. That was wrong: export can be
bolted on afterwards because it reads finished data. Translation cannot, because it
changes how every component is written.

## Decision

**English and French ship together, from the first screen.** `next-intl` provides the
message catalogues and the formatters.

**The locale never appears in the URL.** No `/fr/app`, no rewrite, no locale middleware.
The locale is resolved once per request from the `Accept-Language` header, weighted `q`
values included, and falls back to English.

**The domain packages know nothing about language.** `packages/shared` and
`packages/core` return codes and identifiers; the translation happens in `apps/web`.
Where the domain previously chose user-visible text it now takes it as an argument -
`createHousehold` receives an `accountNames` record instead of naming the three starter
accounts itself.

Catalogues live in `apps/web/messages/{en,fr}.json`, one flat namespace per screen, and
must have identical key sets.

## Alternatives considered

| Option                              | Why it was rejected                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Locale segment in the URL (`/fr/…`) | The standard answer, and it exists for SEO. Altitude is behind authentication on a private host: there is nothing to index, no link to share, no crawler to serve. It buys nothing and costs every route a dynamic segment plus proxy-level rewriting. |
| A per-user locale column            | Better, eventually - but it needs a settings screen and a session to hang off, neither of which exists yet. `Accept-Language` already carries the answer for free, and a stored preference can override it later without changing any component.       |
| A cookie set by a language switcher | Same as above, plus a cookie to keep consistent with the header on first paint. Deferred with the same reasoning.                                                                                                                                      |
| English only, translate at v1.0     | What the plan said. Rejected above: the cost grows with every screen, and the primary audience reads French.                                                                                                                                           |

## Consequences

**Easier.** Adding a third language is a JSON file and one entry in `LOCALES` - no
component changes, because no component holds a string. Dates, numbers and currencies go
through the same locale as the text, so a French user never sees `1,234.56 €`.

**Harder.** Every new screen needs its catalogue entries in both languages before it can
merge, and a contributor who speaks one of them has to write the other or ask. Key parity
is checked, but nothing checks that a French string is _good_ French.

**Accepted.** Resolving the locale per request means every page that renders text is
dynamic. That was already true here - all three screens read the session - so nothing was
given up, but a future statically-rendered marketing page would need its own answer.

**Accepted.** Without a URL prefix there is no way to link someone to a specific
language, and no way to override the browser's choice until a preference exists. For a
single-household self-hosted instance that is a fair trade.

## Revisit if

- A public, unauthenticated surface appears - a landing page, or shared read-only report
  links. Those need indexable per-locale URLs, and this decision does not cover them.
- Users ask to read the interface in a language their browser does not advertise, which
  is the point at which the per-user preference stops being premature.
- A third language arrives with a right-to-left script. Nothing here prevents it, but the
  layout has never been tested against one.
