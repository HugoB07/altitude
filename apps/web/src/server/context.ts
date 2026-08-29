import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import { findMemberships, withHousehold, type Database } from '@altitude/db';
import type { Actor, Role } from '@altitude/core';
import { householdId as toHouseholdId, userId as toUserId } from '@altitude/shared';
import { getAuth, getAuthDbClient } from './auth';

/**
 * Two questions, deliberately kept apart.
 *
 * "Who is signed in?" and "which household are they acting for?" have different
 * answers and different remedies - one sends you to sign-in, the other to
 * setup. Collapsing them into a single nullable result makes creating a first
 * household impossible, because that flow needs a user who has no household
 * yet and one check cannot tell the two apart.
 */

/** A signed-in person, before any household is involved. */
export interface SessionUser {
  readonly userId: ReturnType<typeof toUserId>;
  readonly email: string;
  readonly displayName: string;
}

/** A signed-in person acting for a household. */
export interface RequestContext {
  readonly actor: Actor;
  readonly email: string;
  readonly displayName: string;
  /** The household's own name, for the chrome. Already joined by findMemberships. */
  readonly householdName: string;
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
    super('This account is not a member of any household yet.');
    this.name = 'NoHouseholdError';
  }
}

/**
 * The session, resolved once per render.
 *
 * React's `cache` means the several components of one page share a single
 * resolution rather than each verifying the cookie. It is per-request, so it
 * cannot carry one user's session into another's.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) return null;
  return {
    userId: toUserId(session.user.id),
    email: session.user.email,
    displayName: session.user.name,
  };
});

export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) throw new UnauthenticatedError();
  return user;
}

/**
 * The session resolved to a household and a role.
 *
 * Null means signed in but not yet in a household - the state the setup page
 * exists to resolve.
 */
export const getContext = cache(async (): Promise<RequestContext | null> => {
  const user = await getSessionUser();
  if (user === null) return null;

  const session = await getAuth().api.getSession({ headers: await headers() });
  // A user may belong to several households; the active one lives on the
  // session so two browsers can sit in two households at once.
  const active = (session?.session as { activeHouseholdId?: string | null } | undefined)
    ?.activeHouseholdId;

  const rows = await findMemberships(getAuthDbClient(), user.userId, active ?? undefined);
  const membership = rows[0];
  if (membership === undefined) return null;

  return {
    actor: {
      userId: user.userId,
      householdId: toHouseholdId(membership.householdId),
      role: membership.role as Role,
    },
    email: user.email,
    displayName: user.displayName,
    householdName: membership.householdName,
  };
});

/**
 * `getContext`, refusing rather than returning null - and saying which of the
 * two problems it is, because callers respond to them differently.
 */
export async function requireContext(): Promise<RequestContext> {
  const ctx = await getContext();
  if (ctx !== null) return ctx;
  if ((await getSessionUser()) === null) throw new UnauthenticatedError();
  throw new NoHouseholdError();
}

/**
 * Runs database work bound to the caller's household.
 *
 * The only route from a request to household data. It carries the actor's
 * tenant into the connection, so the row-level security policies have something
 * to filter on - the two barriers of ADR-0007 meeting in one call.
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
