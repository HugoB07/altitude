import { accounts, households, memberships, owners, portfolios } from '@altitude/db';
import type { Database } from '@altitude/db';
import { currency, type HouseholdId, type UserId } from '@altitude/shared';

/**
 * Creating the household a user will then live inside.
 *
 * This is the one write with a chicken-and-egg problem. The INSERT policy on
 * `households` is `WITH CHECK (id = current_household())`, so the row can only
 * be written by a connection already claiming to be that household - which
 * does not exist yet.
 *
 * The way through is to mint the id first and open the unit of work with it.
 * `withHousehold(newId)` then satisfies the policy, and the same setting covers
 * the membership, the portfolio and the starter accounts that follow. Nothing
 * is exempted: the tenant is simply declared before the row that names it.
 */

export interface NewHousehold {
  /** Minted by the caller, because the tenant must be declared before the row. */
  readonly householdId: HouseholdId;
  readonly name: string;
  readonly baseCurrency: string;
  readonly ownerUserId: UserId;
  readonly ownerDisplayName: string;
  /**
   * Names for the three starter accounts, supplied by the caller.
   *
   * The domain does not know what language the person creating the household
   * reads. Translating here would put a message catalogue inside a package that
   * has no browser, no request and no locale, so the caller passes the words and
   * this decides the shapes.
   */
  readonly accountNames: Record<StarterAccount, string>;
}

export type StarterAccount = 'current' | 'savings' | 'opening';

export interface CreatedHousehold {
  readonly householdId: HouseholdId;
  readonly portfolioId: string;
  readonly accountIds: Record<'current' | 'savings' | 'opening', string>;
}

/**
 * The accounts a household cannot function without.
 *
 * `opening` is the counterpart every deposit needs: money entering the
 * household has to come from somewhere, or the transaction does not balance
 * (ADR-0002). Users of double-entry systems know this account; users of this
 * one should not have to, so it is created for them and kept out of net worth
 * by being a liability.
 *
 * Two asset accounts because one is not enough to make an internal transfer,
 * and an internal transfer is the thing a new user should try first - it is
 * what proves the tool is not double-counting their money.
 */
const STARTER_ACCOUNTS = [
  { key: 'current', kind: 'cash' },
  { key: 'savings', kind: 'savings' },
  { key: 'opening', kind: 'other_liability' },
] as const satisfies readonly { key: StarterAccount; kind: string }[];

export async function createHousehold(
  tx: Database,
  input: NewHousehold,
): Promise<CreatedHousehold> {
  const baseCurrency = currency(input.baseCurrency);

  await tx.insert(households).values({
    id: input.householdId,
    name: input.name,
    baseCurrency,
  });

  // The creator is the owner: the only role that may delete the household.
  await tx.insert(memberships).values({
    householdId: input.householdId,
    userId: input.ownerUserId,
    role: 'owner',
  });

  // An owner distinct from the user, per ADR-0003 - the person who *owns* the
  // money, which a household will later have several of, most without a login.
  await tx.insert(owners).values({
    householdId: input.householdId,
    kind: 'person',
    displayName: input.ownerDisplayName,
    userId: input.ownerUserId,
  });

  const [portfolio] = await tx
    .insert(portfolios)
    .values({
      householdId: input.householdId,
      // The root of the ltree path. Every later portfolio hangs off it, so
      // subtree queries have somewhere to start.
      path: 'home',
      name: input.name,
      kind: 'standard',
    })
    .returning({ id: portfolios.id });

  const created = await tx
    .insert(accounts)
    .values(
      STARTER_ACCOUNTS.map((account) => ({
        householdId: input.householdId,
        portfolioId: portfolio!.id,
        name: input.accountNames[account.key],
        kind: account.kind,
        currency: baseCurrency,
      })),
    )
    .returning({ id: accounts.id, name: accounts.name });

  const byKey = Object.fromEntries(
    STARTER_ACCOUNTS.map((account) => [
      account.key,
      created.find((row) => row.name === input.accountNames[account.key])!.id,
    ]),
  ) as CreatedHousehold['accountIds'];

  return { householdId: input.householdId, portfolioId: portfolio!.id, accountIds: byKey };
}
