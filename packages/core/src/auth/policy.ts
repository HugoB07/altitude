import type { HouseholdId, PortfolioId, UserId } from '@altitude/shared';

/**
 * Roles, from most to least privileged. Order matters: `atLeast` compares by
 * index, so inserting a role in the middle changes what existing checks allow.
 */
export const ROLES = ['owner', 'admin', 'contributor', 'viewer', 'child'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { owner: 0, admin: 1, contributor: 2, viewer: 3, child: 4 };

export const ACTIONS = [
  'household:read',
  'household:update',
  'household:delete',
  'member:invite',
  'member:remove',
  'owner:read',
  'owner:write',
  'portfolio:read',
  'portfolio:write',
  'account:read',
  'account:write',
  'transaction:read',
  'transaction:create',
  'transaction:update',
  'transaction:delete',
  'import:run',
  'import:rollback',
  'connector:link',
  'connector:sync',
  'share:create',
  'export:run',
  'settings:update',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Who is asking.
 *
 * `portfolioScope` is undefined for household-wide roles and a concrete list
 * for the scoped ones. Undefined means "the whole household", never "nothing":
 * the roles that carry a scope are the ones restricted by it.
 *
 * Nothing fills it yet. `memberships` has no column for a scope, so every actor
 * built from a session arrives with it undefined - which means a `child` today
 * reads the whole household rather than one subtree. The check below is real and
 * tested; what is missing is somewhere to store the list, and that lands with
 * child portfolios in phase 4 (ADR-0003). Said here because a reader of `can()`
 * would otherwise reasonably assume the scoping is in force.
 */
export interface Actor {
  readonly userId: UserId;
  readonly householdId: HouseholdId;
  readonly role: Role;
  readonly portfolioScope?: readonly PortfolioId[];
}

/** What is being acted on. A missing portfolio means the action is household-wide. */
export interface Resource {
  readonly householdId: HouseholdId;
  readonly portfolioId?: PortfolioId;
}

export interface Denial {
  readonly allowed: false;
  readonly reason: string;
}
export type Decision = { readonly allowed: true } | Denial;

const ALLOW: Decision = { allowed: true };
const deny = (reason: string): Denial => ({ allowed: false, reason });

/**
 * Actions each role may perform, before scope is considered.
 *
 * Written as an explicit table rather than derived from the role ranking. A
 * hierarchy reads well until the first exception, and there is one already:
 * a contributor writes but may not touch connectors, because linking a bank
 * account is not the same kind of trust as recording a transaction.
 */
const GRANTS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(ACTIONS),

  admin: new Set(ACTIONS.filter((a) => a !== 'household:delete')),

  contributor: new Set<Action>([
    'household:read',
    'owner:read',
    'portfolio:read',
    'portfolio:write',
    'account:read',
    'account:write',
    'transaction:read',
    'transaction:create',
    'transaction:update',
    'transaction:delete',
    'import:run',
    'import:rollback',
    'export:run',
  ]),

  viewer: new Set<Action>([
    'household:read',
    'owner:read',
    'portfolio:read',
    'account:read',
    'transaction:read',
    'export:run',
  ]),

  // A child sees their own subtree and nothing else. No export: the point of
  // the role is that the data stays where the parents put it.
  child: new Set<Action>(['portfolio:read', 'account:read', 'transaction:read']),
};

const SCOPED_ROLES: ReadonlySet<Role> = new Set<Role>(['contributor', 'viewer', 'child']);

/**
 * The single authorisation decision in the system.
 *
 * Returns a decision rather than a boolean so the denial can say why - the
 * difference between "you are a viewer" and "that portfolio is not yours"
 * matters to whoever hits it, and reconstructing it at the call site means
 * duplicating this logic there.
 *
 * Checks in order: same household, role grants the action, portfolio in scope.
 * Tenancy first, because a cross-household request is a different kind of
 * problem from an under-privileged one and should never be reported as one.
 */
export function can(actor: Actor, action: Action, resource: Resource): Decision {
  if (actor.householdId !== resource.householdId) {
    return deny('resource belongs to another household');
  }

  if (!GRANTS[actor.role].has(action)) {
    return deny(`role "${actor.role}" cannot perform "${action}"`);
  }

  if (SCOPED_ROLES.has(actor.role) && actor.portfolioScope !== undefined) {
    if (resource.portfolioId === undefined) {
      return deny(`role "${actor.role}" is limited to specific portfolios`);
    }
    if (!actor.portfolioScope.includes(resource.portfolioId)) {
      return deny("portfolio is outside this member's scope");
    }
  }

  return ALLOW;
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  readonly action: Action;

  constructor(action: Action, reason: string) {
    super(`Not allowed to ${action}: ${reason}.`);
    this.name = 'ForbiddenError';
    this.action = action;
  }
}

/**
 * The form every mutation uses.
 *
 * Throwing rather than returning is deliberate: a caller that ignores a
 * returned boolean carries on regardless, and an authorisation check that can
 * be ignored by forgetting an `if` is not a check.
 */
export function assertCan(actor: Actor, action: Action, resource: Resource): void {
  const decision = can(actor, action, resource);
  if (!decision.allowed) {
    throw new ForbiddenError(action, decision.reason);
  }
}

/** True when the actor's role is at least as privileged as `role`. */
export function atLeast(actor: Actor, role: Role): boolean {
  return RANK[actor.role] <= RANK[role];
}
