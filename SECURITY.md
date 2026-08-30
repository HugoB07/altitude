# Security Policy

Altitude holds a complete map of a household's wealth: account balances, positions,
property, debt, and - once connectors exist - tokens granting read access to real bank
accounts. We treat security reports accordingly.

## Project status

Altitude is **pre-release**. The ledger, the schema with its row-level security,
authentication and the first screens exist and are tested; there is no release and no
instance anyone but a developer runs. The isolation guarantees described below are
implemented and covered by tests, so a report against them is a real report, not a
report against a plan.

| Version                   | Supported                            |
| ------------------------- | ------------------------------------ |
| `main` (pre-release)      | Best effort - no stability guarantee |
| _no released version yet_ | -                                    |

Once 1.0 ships, the latest minor version receives security fixes, and the previous minor
version receives them for 90 days after its successor's release.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through **GitHub Private Vulnerability Reporting**: the repository's _Security_
tab → _Report a vulnerability_. The report stays private until a fix is published, the
whole exchange lives in one place, and you are credited automatically in the advisory.

There is deliberately no email address here. A published inbox collects far more spam
than it does vulnerability reports, and private reporting on GitHub does the same job
with a clearer trail.

### What to include

- The affected component and version or commit.
- Reproduction steps, ideally a minimal proof of concept.
- What an attacker gains: read access to another household's data, remote code
  execution, credential disclosure, and so on.
- Your assessment of severity, and whether the issue is already public anywhere.

**Never include real financial data in a report.** If a reproduction needs a bank export,
anonymise it first - see the anonymisation checklist in `CONTRIBUTING.md`.

### What to expect

| Stage                                            | Target                                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| Acknowledgement of your report                   | 7 days                                               |
| Initial assessment and severity                  | 14 days                                              |
| Fix or documented mitigation for critical issues | 30 days                                              |
| Public disclosure                                | after a fix ships, or 90 days, whichever comes first |

This is a volunteer project with no funded security team, and these are targets rather
than contractual commitments. If a deadline is going to slip, we will say so rather than
go quiet. There is **no bug bounty** - we cannot pay, and we would rather be honest about
that up front than imply otherwise.

Reporters are credited in the release notes and in the advisory unless they prefer to
stay anonymous.

## Scope

### In scope

- Cross-household data access - one household reading or modifying another's data. This
  is the most serious class of bug in this codebase.
- Authentication and session flaws: bypass, fixation, privilege escalation between roles
  (owner, admin, contributor, viewer, child).
- Disclosure of connector secrets, API tokens, or encrypted fields.
- Injection reaching the database, the shell, or another user's browser (SQLi, XSS, CSV
  formula injection in exports, XXE in the XML importers).
- SSRF through a user-supplied URL or a provider configuration.
- Vulnerabilities in the import pipeline: a crafted CSV/XLSX/OFX/CAMT file causing code
  execution, resource exhaustion beyond the documented limits, or path traversal.
- Flaws in the connector consent flow: OAuth state handling, redirect validation, scope
  escalation towards payment initiation.
- Container escape or privilege escalation from the shipped Docker images.
- Secrets leaking into logs, error reports, or backups.

### Out of scope

- **Deployment mistakes.** An instance published to the internet with no TLS, with
  registration left open, or with a weak password is a misconfiguration, not a
  vulnerability. We do want to hear about cases where our defaults or documentation
  _lead_ people into that mistake - that is a real bug, and we will treat it as one.
- Anything requiring an already-compromised host, database, or administrator account.
- Missing hardening headers with no demonstrated impact.
- Self-XSS, or attacks requiring the victim to paste code into their own console.
- Rate limiting on endpoints where absence of it has no security consequence.
- Vulnerabilities in third-party aggregators, banks, or quote providers. Report those to
  the vendor; tell us if Altitude needs to work around it.
- Social engineering, physical access, and attacks against contributors.
- Automated scanner output with no analysis attached. A dependency flagged as vulnerable
  in a code path we do not execute is not a finding on its own - show the reachable path.

## Safe harbour

We will not pursue or support legal action against anyone who, in good faith:

- tests only against **their own instance**, never against someone else's data;
- avoids privacy violations, data destruction, and service degradation;
- gives us a reasonable window to fix the issue before disclosing it publicly.

If you are unsure whether something is in scope, report it and ask. A question is always
welcome; unauthorised testing against a third party's instance never is.

## Design commitments that are security requirements

These are not aspirations - a regression in any of them is a bug, and several are
enforced by tests. The reasoning is in the development plan (`docs/plan/`, §7 and §13).

- **Two isolation barriers.** Every query is scoped in the application layer _and_ by
  PostgreSQL Row Level Security. One of them failing must not be enough to leak data.
- **No bank credentials, ever.** Altitude never asks for, transmits, or stores a bank
  password. Connectors redirect the user to their own bank.
- **Read-only by construction.** Only account-information scopes are requested. A
  payment-initiation scope appearing in any provider response is an error condition.
- **Secrets encrypted with a key held outside the database**, so a stolen dump alone
  grants no access.
- **No telemetry, no third-party assets.** An instance disconnected from the internet
  must work. Every outbound destination is listed in the UI and can be disabled.
- **Redaction in logs.** IBANs, tokens, amounts, and counterparty names never appear at
  `info` level.

## Dependencies

- Versions are locked; updates land through Renovate with a quarantine delay.
- Any new dependency needs human review - `packages/core` is kept deliberately thin.
- Advisories are checked in CI, and an SBOM (CycloneDX) is published with each release.

If you find a vulnerability in a dependency that Altitude actually reaches, report it
here as well as upstream, so we can pin or patch while the fix travels.
