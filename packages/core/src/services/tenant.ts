import { sql } from 'drizzle-orm';
import type { Database } from '@altitude/db';
import type { Actor } from '../auth/policy';

export class TenantScopeError extends Error {
  readonly code = 'TENANT_SCOPE_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

/**
 * Verifies the actor belongs to the household this work is bound to.
 *
 * `assertCan` compares the actor's household to the resource's, which for a
 * whole-household query means comparing it to itself - it checks the role and
 * nothing about tenancy. The tenancy that matters here is the connection's:
 * `withHousehold` set it, and an actor from a different household reaching this
 * point means a caller scoped to one and authorised against another.
 *
 * Row-level security would still return the right rows, so nothing would look
 * wrong - the caller would simply be acting for a household it did not intend.
 * That is a bug worth failing on rather than serving.
 *
 * Lives in its own module because every service needs it and none of them
 * should own it. It was private to the transactions service until the accounts
 * one needed the same guarantee.
 */
export async function assertActorMatchesTenant(tx: Database, actor: Actor): Promise<void> {
  const [row] = await tx.execute<{ tenant: string | null }>(
    sql`SELECT current_setting('app.current_household', true) AS tenant`,
  );
  const tenant = row?.tenant ?? '';

  if (tenant === '') {
    throw new TenantScopeError(
      'This work is not bound to a household. Wrap it in withHousehold().',
    );
  }
  if (tenant !== actor.householdId) {
    throw new TenantScopeError(
      `Actor belongs to household ${actor.householdId} but this work is bound to ${tenant}.`,
    );
  }
}
