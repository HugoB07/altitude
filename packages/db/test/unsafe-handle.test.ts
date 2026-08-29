import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * The fence around `Client.unsafe` that ADR-0007 said was missing.
 *
 * `unsafe` is the raw handle, bound to no household. Reaching household data
 * through it skips the first barrier entirely, and nothing about the result
 * looks wrong: the query succeeds and returns rows from every household.
 *
 * Written as a test rather than a lint rule for the same reason as the secrets
 * guard in `packages/shared/test/env.test.ts` - a test is what CI actually
 * runs. It scans source rather than types, which is crude, but the pattern it
 * looks for is unambiguous and the allow list is three entries long.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', 'coverage', 'docs']);

/**
 * Where reaching for the raw handle is legitimate, and why.
 *
 * Kept as an explicit list so that adding to it is a decision someone makes in
 * a diff, with a reason, rather than a rule quietly eroding.
 */
const ALLOWED: ReadonlyArray<{ readonly path: string; readonly why: string }> = [
  {
    path: join('packages', 'db', 'src'),
    why: 'defines the handle, and withHousehold/withUser are what bind it to a tenant',
  },
  {
    path: join('apps', 'web', 'src', 'server', 'auth.ts'),
    why: "Better Auth's tables carry no household, so its adapter cannot be tenant-scoped",
  },
];

function isAllowed(relativePath: string): boolean {
  return ALLOWED.some(({ path }) => relativePath === path || relativePath.startsWith(path + sep));
}

async function sourceFiles(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, found);
    // Tests are exempt: proving the barrier holds means reaching past it on
    // purpose, and a guard that forbade that would forbid its own evidence.
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Comments describe the rule; they are not violations of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * `.unsafe` used as a value, not `.unsafe(...)` called as a function.
 *
 * postgres.js has its own unrelated `sql.unsafe(query)` for raw SQL, which is
 * always invoked. Ours is a property read, passed somewhere or destructured.
 * The trailing `(` is what tells the two apart.
 */
const RAW_HANDLE = /\.\s*unsafe\b(?!\s*\()/;

describe('the raw database handle stays inside packages/db', () => {
  it('is not reached for anywhere else', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(join(ROOT, 'apps'))) {
      if (RAW_HANDLE.test(stripComments(await readFile(file, 'utf8')))) {
        const rel = relative(ROOT, file);
        if (!isAllowed(rel)) offenders.push(rel);
      }
    }
    for (const file of await sourceFiles(join(ROOT, 'packages'))) {
      if (RAW_HANDLE.test(stripComments(await readFile(file, 'utf8')))) {
        const rel = relative(ROOT, file);
        if (!isAllowed(rel)) offenders.push(rel);
      }
    }

    expect(
      offenders,
      'use withHousehold() or scoped() - the raw handle is bound to no household (ADR-0007)',
    ).toEqual([]);
  });

  it('recognises a value read and ignores a postgres.js raw query', () => {
    // The distinction the whole guard rests on, asserted rather than assumed.
    expect(RAW_HANDLE.test('drizzleAdapter(dbClient().unsafe, {')).toBe(true);
    expect(RAW_HANDLE.test('const { unsafe } = client;\nreturn client.unsafe;')).toBe(true);
    expect(RAW_HANDLE.test('await sql.unsafe(`CREATE ROLE altitude_app`)')).toBe(false);
    expect(RAW_HANDLE.test('await admin.unsafe(statement)')).toBe(false);
  });

  it('keeps a reason next to every exemption', () => {
    for (const { path, why } of ALLOWED) {
      expect(why.length, `${path} is exempt without saying why`).toBeGreaterThan(20);
    }
  });
});
