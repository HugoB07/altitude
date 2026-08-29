import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import { findMemberships, withHousehold, type Database } from '@altitude/db';
import type { Actor, Role } from '@altitude/core';
import { householdId as toHouseholdId, userId as toUserId } from '@altitude/shared';
import { getAuth, getAuthDbClient } from './auth';

/**
 * Who is making this request, and which household for.
 *
 * The single place a session becomes an `Actor`. Everything that reads or
 * writes household data starts here: `getContext()` to learn who is asking,
 * `assertCan()` to decide whether they may, `scoped()` to run the work bound to
 * their tenant. Skipping any of the three is the bug this shape exists to make
 * visible in review.
 */
export interface RequestContext {
  readonly actor: Actor;
  readonly email: string;
  readonly displayName: string;
}

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('No active session.');
    this.name = 'UnauthenticatedError';
  }
}

export class NoHouseholdError extends Error {
  readonly code = 'NO_HOUSEHOLD';
  constructor() {
    super('This account is not a member of any household.');
    this.name = 'NoHouseholdError';
  }
}

/**
 * Resolves the current session to an actor, or null when signed out.
 *
 * Wrapped in React's `cache` so the several components of one render share a
 * single resolution rather than each querying memberships. The cache is
 * per-request: it cannot carry one user's context into another's.
 */
export const getContext = cache(async (): Promise<RequestContext | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) return null;

  const userId = toUserId(session.user.id);

  // The household on the session when there is one, otherwise the membership
  // that exists. A user with several and none chosen is asked to pick, rather
  // than being dropped into whichever the database returned first.
  const active = (session.session as { activeHouseholdId?: string | null }).activeHouseholdId;

  const rows = await findMemberships(getAuthDbClient(), userId, active ?? undefined);
  const membership = rows[0];
  if (membership === undefined) return null;

  return {
    actor: {
      userId,
      householdId: toHouseholdId(membership.householdId),
      role: membership.role as Role,
    },
    email: session.user.email,
    displayName: session.user.name,
  };
});

/** `getContext`, refusing rather than returning null. For anything past the login wall. */
export async function requireContext(): Promise<RequestContext> {
  const ctx = await getContext();
  if (ctx === null) throw new UnauthenticatedError();
  return ctx;
}

/**
 * Runs database work bound to the caller's household.
 *
 * The only route from a request to household data. It carries the actor's
 * tenant into the connection, so the row-level security policies have something
 * to filter on — the two barriers of ADR-0007 meeting in one call.
 *
 * It takes no household argument on purpose. A caller that could name the
 * household would eventually name the wrong one; here the tenant comes from the
 * session and nowhere else.
 */
export async function scoped<T>(work: (tx: Database) => Promise<T>): Promise<T> {
  const { actor } = await requireContext();
  return withHousehold(
    getAuthDbClient(),
    { householdId: actor.householdId, userId: actor.userId },
    work,
  );
}
