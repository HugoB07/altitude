import 'server-only';
import { isCurrencyCode } from '@altitude/shared';
import { optionalEnv } from '@altitude/shared/env';

/**
 * What the instance is configured with, as opposed to what a request carries.
 *
 * `context.ts` answers "who is signed in and for which household". This answers
 * "what did whoever runs this server choose", which is a different question
 * with a different lifetime - and one that has to be answerable before a
 * household exists at all, which is the case the first-run wizard is.
 */

/**
 * The currency the first-run wizard offers, per the plan (§14.1): "default
 * consolidation currency, changeable per household afterwards".
 *
 * Both halves matter. A household keeps its own currency on its own row and can
 * be one of several on an instance, so this is not that - it is the answer the
 * wizard starts from. Written into the wizard's own source it was `'EUR'`, so
 * an instance run from Zurich started every household in euros and there was no
 * way to say otherwise.
 *
 * `optionalEnv` rather than `??`, which the workspace forbids and which
 * `packages/shared/test/env.test.ts` walks the source to enforce. The
 * distinction it is drawing: a missing database URL must stop the process,
 * because a fallback would connect somewhere nobody intended; a missing default
 * currency has a genuine answer, and euro is it for a project whose first
 * presets are French.
 *
 * A value that is set and is not a currency throws rather than falling back. A
 * typo silently ignored is an instance quietly running on a default the
 * operator believes they changed, which is the shape of mistake this whole
 * module exists to refuse.
 */
export function defaultBaseCurrency(): string {
  const configured = optionalEnv('ALTITUDE_BASE_CURRENCY', 'EUR').trim().toUpperCase();

  if (!isCurrencyCode(configured)) {
    // Deliberately the same rule the ledger uses and no stricter: three to ten
    // letters, because the plan treats crypto and stablecoins as currencies
    // rather than as securities (§11.3) and USDT is not ISO 4217.
    throw new Error(
      `ALTITUDE_BASE_CURRENCY is "${configured}", which is not a currency code: ` +
        'three to ten letters, ISO 4217 for fiat or the ticker for crypto. ' +
        'See .env.example for the expected value.',
    );
  }

  return configured;
}
