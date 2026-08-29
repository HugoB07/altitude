# ADR-0009 - Next.js 16 and TypeScript 6

- **Status:** accepted
- **Date:** 2026-08-29
- **Deciders:** @HugoB07

## Context

The development plan was written against Next.js 15. By the time phase 0 started, two
things had moved:

- **Next.js 16.3.3** had shipped, so starting on 15 would mean a major upgrade with real
  code already written.
- **TypeScript 7.0.2** - the native Go compiler - was `latest` on npm, alongside 6.0.3
  (the last JavaScript-based compiler) and 5.9.3.

TypeScript 7 is genuinely faster, and the temptation was to take it. Rather than guess,
the whole toolchain was probed against Altitude's real stack: Drizzle schema with
`numeric` columns, Zod 4, decimal.js, a Next route handler with async params, and Vitest.

## Measurements

Measured on the target machine, same probe, same strict `tsconfig`:

|                  | `tsc` | `next build`        | Vitest | typescript-eslint | typecheck |
| ---------------- | ----- | ------------------- | ------ | ----------------- | --------- |
| TypeScript 5.9.3 | pass  | pass (15 and 16)    | pass   | pass              | 3.4 s     |
| TypeScript 6.0.3 | pass  | pass (16)           | pass   | pass              | 3.3 s     |
| TypeScript 7.0.2 | pass  | **pass on 16 only** | pass   | **fails**         | **1.2 s** |

Two hard blockers for TypeScript 7, neither of them a warning:

- Next.js 15 refuses it outright: _"The TypeScript 7 native compiler does not provide the
  JavaScript compiler API that Next.js requires."_ Support starts at Next 16.2.11.
- `typescript-eslint` 8.68 throws on load: `typescript-eslint does not support TS 7.0`.

Strictness was confirmed rather than assumed: a deliberately broken file was checked, and
TypeScript 7 correctly reported `noUncheckedIndexedAccess`, assignability and
`strictNullChecks` violations.

## Decision

**Next.js 16, TypeScript 6.0.3.**

TypeScript 7 is roughly 2.8× faster here, and the gap grows with codebase size. It is
still the wrong trade today: taking it would mean dropping type-aware linting, which is
step 2 of the CI pipeline (plan §15.2) and the thing that catches floating promises and
implicit `any` - precisely the defects a financial calculation engine cannot carry.

TypeScript 6 is the newest version the entire toolchain accepts, and it keeps the eventual
6 → 7 step shorter than 5.9 → 7 would have been.

Next 16 rather than 15 because a project with no code should not be born a major version
behind, and 16 is the release that will accept TypeScript 7 once the linter follows.

## Alternatives considered

| Option                                        | Why it was rejected                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Next 16 + TypeScript 7, no type-aware lint    | Trades the strongest correctness tool in the stack for ~2 s of typecheck on a codebase that does not exist yet.                                                    |
| Next 16 + TypeScript 7, lint on a pinned TS 6 | Two compiler versions resolved in one workspace: pnpm can express it, but the lint would then check different types from the build. Worse than either pure option. |
| Next 15 + TypeScript 5.9                      | What the plan said. Now a major behind, and it forecloses TypeScript 7 entirely.                                                                                   |

## Consequences

**Easier.** The whole toolchain agrees on one compiler version. Next 16 is current, so the
first upgrade is not a migration.

**Harder.** Typechecks stay around 3 s rather than 1 s, and that cost grows as the project
does. It is felt in CI and in editor responsiveness.

**Accepted.** The plan's stack table and architecture diagram now read Next.js 16;
`docs/plan/parts/` was updated with this ADR.

## Revisit if

`typescript-eslint` announces TypeScript 7 support. That is the single condition. When it
lands, re-run the probe and move to 7 - the measured speed gain is worth taking as soon
as it costs nothing.
