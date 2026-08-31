import { and, eq } from 'drizzle-orm';
import { withUser, type Client } from '../client';
import { households, memberships } from '../schema/identity';
import type { UserId } from '@altitude/shared';

export interface MembershipRow {
  readonly householdId: string;
  readonly householdName: string;
  /** What this household counts in. Joined here so no screen has to guess. */
  readonly baseCurrency: string;
  readonly role: string;
}

/**
 * The households a user belongs to.
 *
 * Runs under `withUser`, not `withHousehold`: this is the one question that
 * cannot be asked from inside a household. The policies added in migration 0004
 * let a user see their own membership rows and the households they name - the
 * filter is the user's own id, taken from a verified session, never from a
 * request parameter.
 */
export async function findMemberships(
  client: Client,
  userId: UserId,
  householdId?: string,
): Promise<MembershipRow[]> {
  const where =
    householdId === undefined
      ? eq(memberships.userId, userId)
      : and(eq(memberships.userId, userId), eq(memberships.householdId, householdId));

  return withUser(client, userId, (tx) =>
    tx
      .select({
        householdId: memberships.householdId,
        householdName: households.name,
        baseCurrency: households.baseCurrency,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(households, eq(households.id, memberships.householdId))
      .where(where),
  );
}
