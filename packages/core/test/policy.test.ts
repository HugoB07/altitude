import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ForbiddenError,
  ROLES,
  assertCan,
  atLeast,
  can,
  type Action,
  type Actor,
  type Role,
} from '../src/index.js';
import { householdId, portfolioId, userId } from '@altitude/shared';

const HOUSE = householdId('11111111-1111-4111-8111-111111111111');
const OTHER = householdId('22222222-2222-4222-8222-222222222222');
const MINE = portfolioId('33333333-3333-4333-8333-333333333333');
const THEIRS = portfolioId('44444444-4444-4444-8444-444444444444');
const USER = userId('55555555-5555-4555-8555-555555555555');

const actor = (role: Role, scope?: readonly ReturnType<typeof portfolioId>[]): Actor => ({
  userId: USER,
  householdId: HOUSE,
  role,
  ...(scope !== undefined ? { portfolioScope: scope } : {}),
});

describe('tenancy is checked before privilege', () => {
  it('refuses another household even to the owner', () => {
    const decision = can(actor('owner'), 'account:read', { householdId: OTHER });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/another household/);
  });

  it('reports cross-household separately from insufficient privilege', () => {
    // A viewer asking to write in another household is refused for tenancy,
    // not for their role. Reporting the role first would tell an outsider that
    // the resource exists and would be reachable with a better one.
    const decision = can(actor('viewer'), 'account:write', { householdId: OTHER });
    expect(decision.allowed === false && decision.reason).toMatch(/another household/);
  });
});

describe('role grants', () => {
  it('gives the owner everything', () => {
    for (const action of ACTIONS) {
      expect(can(actor('owner'), action, { householdId: HOUSE }).allowed).toBe(true);
    }
  });

  it('withholds only household deletion from an admin', () => {
    const denied = ACTIONS.filter((a) => !can(actor('admin'), a, { householdId: HOUSE }).allowed);
    expect(denied).toEqual(['household:delete']);
  });

  it('lets a contributor write transactions but not link a bank', () => {
    const a = actor('contributor');
    expect(can(a, 'transaction:create', { householdId: HOUSE }).allowed).toBe(true);
    expect(can(a, 'import:run', { householdId: HOUSE }).allowed).toBe(true);
    expect(can(a, 'connector:link', { householdId: HOUSE }).allowed).toBe(false);
  });

  it('makes a viewer read-only', () => {
    const a = actor('viewer');
    expect(can(a, 'transaction:read', { householdId: HOUSE }).allowed).toBe(true);
    for (const action of ['transaction:create', 'account:write', 'import:run'] as Action[]) {
      expect(can(a, action, { householdId: HOUSE }).allowed).toBe(false);
    }
  });

  it('keeps a child from exporting', () => {
    // The point of the role is that the data stays where the parents put it.
    expect(can(actor('child'), 'export:run', { householdId: HOUSE }).allowed).toBe(false);
    expect(can(actor('child'), 'share:create', { householdId: HOUSE }).allowed).toBe(false);
  });

  it('gives no role a grant the owner lacks', () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        if (can(actor(role), action, { householdId: HOUSE }).allowed) {
          expect(can(actor('owner'), action, { householdId: HOUSE }).allowed).toBe(true);
        }
      }
    }
  });
});

describe('portfolio scope', () => {
  it('allows a scoped contributor inside their scope', () => {
    const a = actor('contributor', [MINE]);
    expect(can(a, 'transaction:create', { householdId: HOUSE, portfolioId: MINE }).allowed).toBe(
      true,
    );
  });

  it('refuses a scoped contributor outside it', () => {
    const a = actor('contributor', [MINE]);
    const decision = can(a, 'transaction:create', { householdId: HOUSE, portfolioId: THEIRS });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/outside/);
  });

  it('refuses a household-wide action to a scoped member', () => {
    // No portfolio on the resource means the action spans the household, which
    // is precisely what a scoped role must not reach.
    const decision = can(actor('viewer', [MINE]), 'account:read', { householdId: HOUSE });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/limited to specific portfolios/);
  });

  it('treats an absent scope as the whole household, not as nothing', () => {
    expect(can(actor('viewer'), 'account:read', { householdId: HOUSE }).allowed).toBe(true);
  });

  it('ignores scope for household-wide roles', () => {
    // An owner carrying a stale scope is still an owner; the roles that a
    // scope restricts are the ones that opt into it.
    const scopedOwner: Actor = { ...actor('owner'), portfolioScope: [MINE] };
    expect(
      can(scopedOwner, 'account:read', { householdId: HOUSE, portfolioId: THEIRS }).allowed,
    ).toBe(true);
  });
});

describe('assertCan', () => {
  it('passes silently when allowed', () => {
    expect(() => assertCan(actor('owner'), 'account:write', { householdId: HOUSE })).not.toThrow();
  });

  it('throws with the action and the reason', () => {
    try {
      assertCan(actor('viewer'), 'transaction:create', { householdId: HOUSE });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).action).toBe('transaction:create');
      expect((error as Error).message).toMatch(/role "viewer"/);
    }
  });
});

describe('atLeast', () => {
  it('orders roles from owner down to child', () => {
    expect(atLeast(actor('owner'), 'admin')).toBe(true);
    expect(atLeast(actor('admin'), 'admin')).toBe(true);
    expect(atLeast(actor('contributor'), 'admin')).toBe(false);
    expect(atLeast(actor('child'), 'viewer')).toBe(false);
  });
});
