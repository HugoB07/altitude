import 'server-only';

import { assertTenantScopingActive } from '@altitude/db';
import { getAuthDbClient } from './auth';

/**
 * Checks, once, that this process can actually isolate households.
 *
 * `assertTenantScopingActive` has existed since day 4 and nothing called it,
 * which made it a guard that guarded nothing. It matters most for the case the
 * SQL cannot cover on its own: a superuser ignores row-level security entirely,
 * and FORCE ROW LEVEL SECURITY does not reach them - so migration 0002 buys
 * nothing if DATABASE_URL points at the role a Postgres image creates from
 * POSTGRES_USER.
 *
 * Run on the first request rather than at import: module scope is also `next
 * build`, and a build must not need a database.
 *
 * The result is cached both ways. A pass is not rechecked; a failure is
 * rethrown rather than retried, because a misconfigured role does not fix
 * itself and retrying would turn one clear error into one per request.
 */
let outcome: Promise<void> | undefined;

export function ensureTenantIsolation(): Promise<void> {
  outcome ??= assertTenantScopingActive(getAuthDbClient());
  return outcome;
}
