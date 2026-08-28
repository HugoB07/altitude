# Contributing to Altitude

Thanks for looking. This document says what is useful right now, what the conventions
are, and what will not be accepted — so nobody spends an evening on a pull request that
was never going to land.

## Current phase: design

**There is no code yet.** The repository holds the development plan, the licence, and
project groundwork. Code contributions cannot be reviewed because there is nothing to
build on. That changes when phase 0 lands (see the roadmap in `README.md`).

### What is useful today

- **Critique of the plan.** Read `docs/plan/` — particularly §5 (data model), §6
  (calculation engine) and §7 (bank synchronisation). If a modelling decision is wrong,
  now is when it is cheap to fix. Open a discussion, not a pull request.
- **Anonymised bank and broker export samples.** These are the single most valuable
  contribution before code exists. Every import preset needs a real-world file to test
  against, and no one person has an account at every bank. Read the anonymisation
  section below first — it is not optional.
- **ETF exposure data.** Country and sector breakdowns for widely held ETFs, with an
  as-of date and a cited source. This is what makes the geographic globe meaningful.
- **Prior art we have missed.** If an existing project already solved something well,
  say so. Borrowing beats reinventing.

### What is useful once phase 0 lands

- **Import presets** — the intended entry point for new contributors: a JSON file plus a
  test fixture, no TypeScript required. Format documented in `docs/plan/` §8.4.
- Bug fixes, tests, documentation, translations.
- Feature work that is already on the roadmap. Please claim the issue first.

## Ground rules

### Sign your commits off (DCO)

Altitude uses the [Developer Certificate of Origin](https://developercertificate.org/)
rather than a CLA. You keep your copyright; you certify you have the right to submit the
code. Add a sign-off line to every commit:

```bash
git commit -s -m "feat(importers): add preset for Bank X"
```

That appends `Signed-off-by: Your Name <your@email>`. Commits without it will be asked
to amend.

### Licence

Contributions are licensed under **AGPL-3.0-or-later**, like the rest of the project. If
you are contributing on behalf of an employer, make sure they are fine with that before
you start.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(importers): add BoursoBank current-account preset
fix(ledger): keep FX rate frozen when a transaction is edited
docs(plan): correct the PSD2 consent renewal period
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.
Explain **why** in the body when the reason is not obvious from the diff.

### Branches and pull requests

- Branch from `main`: `feat/short-description`, `fix/short-description`.
- One logical change per pull request. A 2,000-line PR touching six concerns will not
  get a useful review.
- Say what you changed and why. If it changes behaviour, say how you verified it.
- Green CI is required. So is one review.

## Anonymising financial data

**This matters more than anything else in this document.**

Import presets need real bank exports to test against, and real bank exports contain
your account number, your balance, your salary, your landlord's name and your grocery
habits. Once attached to an issue, that is public forever and cannot be recalled — a
private repository today can be made public tomorrow.

Before attaching any export file:

- [ ] Replace account numbers and IBANs with obvious fakes (`FR7630001007941234567890185`).
- [ ] Replace all amounts with invented ones. **Keep the format** — the decimal comma, the
      thousands separator, the parentheses for negatives — because the format is exactly
      what the parser is being tested on. The values themselves are irrelevant.
- [ ] Replace counterparty and merchant names, but keep their *shape*: if the bank writes
      `CARTE 12/03 CARREFOUR MARKET 3388`, keep the prefix, the embedded date and the
      trailing digits, because the preset's rules key off that structure.
- [ ] Remove your name, address, phone number, customer number and adviser's name.
- [ ] Cut the file down to 20–50 rows. A preset test does not need three years of history;
      it needs one example of each transaction shape.
- [ ] Keep the original encoding and line endings — CP1252 and CRLF are part of the test.
- [ ] Open the finished file and read it. Every line.

If you would not post it in a public forum, do not attach it. When in doubt, describe the
format in an issue and we will work out the fixture together.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, your version, and
your deployment method. Redact amounts and account identifiers — a screenshot with the
privacy mode enabled (`Ctrl/⌘ + Shift + H`) is usually enough.

**Security bugs do not go in the issue tracker.** See `SECURITY.md`.

## What will not be accepted

Saying this plainly saves everyone time. These are not judgements about the ideas; they
are consequences of what Altitude is, and the reasoning for each is in `docs/plan/`.

- **Bank scraping in the core.** No `woob` bridge, no headless-browser login, no storing
  bank passwords. It breaches bank terms of service, it breaks constantly, and it exposes
  users in a fraud dispute. The `Connector` interface is public: publish a scraper as a
  separate package if you want one. Reasoning in §7.5.
- **Bundled API credentials.** No aggregator or price-provider key ever enters the
  repository, not even a free-tier one, and not even in an example file.
- **Telemetry, analytics, or a phone-home update check enabled by default.** §13.2.
- **Third-party assets loaded at runtime** — CDN scripts, remote fonts, hosted icons. A
  disconnected instance must render perfectly.
- **Payment initiation.** Altitude reads; it never moves money.
- **Investment advice.** Projections are simulations and are labelled as such. Tax
  modules produce filing-assistance figures, never recommendations. No "you should buy"
  features, however they are framed.
- **Floating-point money.** `numeric` in the database, `decimal.js` in TypeScript, strings
  at JSON boundaries. A pull request introducing a `number` for an amount will be asked to
  change it. §ADR-006.
- **Business logic in a Server Action or a Route Handler.** Both call
  `packages/core/services`; neither implements anything. §ADR-005.
- **A dependency added without justification.** Especially in `packages/core`, which must
  keep working with no browser, no server and no network.

## Development setup

Not applicable yet — there is nothing to run. When phase 0 lands, this section will
describe the two commands needed to get a working instance, and the target is under ten
minutes from clone to a signed-in page. If it takes longer than that, treat it as a bug
in the documentation and say so.

The one thing you can build today is the development plan itself:

```bash
cd docs/plan
node build-html.mjs
node build-pdf.mjs
```

Requires Node 22+ and a local Chrome. Details in `docs/plan/README.md`.

## Getting in touch

Open a GitHub discussion for anything design-related, an issue for anything concrete.
Questions are welcome — an hour of discussion beats a week spent building the wrong
thing.
