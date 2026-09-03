import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing a client component can reach may import the domain packages.
 *
 * `@altitude/core` and `@altitude/db` import `postgres`, which imports `fs`,
 * `net` and `perf_hooks`. Pulled into a bundle meant for a browser, the build
 * stops at "Module not found: Can't resolve 'fs'" - a message that names the
 * database driver and says nothing about the component that asked for it.
 *
 * This has now happened four times: a preset registry imported for a datalist,
 * a text decoder imported for an upload, and twice more. The fourth got past
 * the first version of this check, which read one file: `importer.tsx` imported
 * a constant from a preset registry, which imports the readers, which import
 * core. The client file named nothing forbidden and pulled the driver in all
 * the same, so the check follows the chain now.
 *
 * dependency-cruiser cannot do this, because `'use client'` is a directive
 * rather than a path. So the check reads the directive.
 *
 * The way out is never to work around the bundler. It is one of:
 *
 *   - the server component that renders this one passes the data as a prop
 *   - the helper is pure and belongs in `@altitude/shared`, or in a module of
 *     its own with no imports
 *   - the call belongs in a Server Action, which is the boundary (ADR-0005)
 */

const WEB = join(import.meta.dirname, '..', 'src');
const FORBIDDEN = ['@altitude/core', '@altitude/db'];

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

const isClient = (contents: string) => /^\s*(['"])use client\1/.test(contents.slice(0, 200));
const isServerAction = (contents: string) => /^\s*(['"])use server\1/.test(contents.slice(0, 200));

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The local files this one pulls in, resolved far enough to follow.
 *
 * `@/x` and `./x` only. A package import is either forbidden outright or is a
 * leaf as far as this is concerned, and a Server Action is a leaf too:
 * `'use server'` is a boundary, and what lies behind it never reaches a bundle.
 */
async function localImports(path: string, contents: string): Promise<string[]> {
  if (isServerAction(contents)) return [];

  const found: string[] = [];
  for (const match of contents.matchAll(/from\s+'(\.[^']*|@\/[^']*)'/g)) {
    const target = match[1]!;
    const base = target.startsWith('@/') ? join(WEB, target.slice(2)) : join(path, '..', target);

    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (await exists(`${base}${suffix}`)) {
        found.push(`${base}${suffix}`);
        break;
      }
    }
  }
  return found;
}

describe('the client bundle stays out of the domain packages', () => {
  it('nothing reachable from a "use client" file imports core or db', async () => {
    const offenders: string[] = [];

    for (const entry of await sources(WEB)) {
      if (!isClient(await readFile(entry, 'utf8'))) continue;

      const seen = new Set<string>();
      const queue = [entry];

      while (queue.length > 0) {
        const path = queue.pop()!;
        if (seen.has(path)) continue;
        seen.add(path);

        const contents = await readFile(path, 'utf8');

        // A Server Action is where the bundle stops. Its body runs on the
        // server whoever imports it, so what it imports is not the caller's
        // problem - and counting it would report every screen that records a
        // transaction.
        if (isServerAction(contents)) continue;

        for (const packageName of FORBIDDEN) {
          if (contents.includes(`from '${packageName}'`)) {
            const from = entry.slice(WEB.length + 1);
            const via = path === entry ? '' : ` (via ${path.slice(WEB.length + 1)})`;
            offenders.push(`${from} reaches ${packageName}${via}`);
          }
        }
        queue.push(...(await localImports(path, contents)));
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it('finds the client components, so a passing result means something', async () => {
    const all = await sources(WEB);
    const clients = await Promise.all(
      all.map(async (path) => isClient(await readFile(path, 'utf8'))),
    );

    // A scan that matched nothing would pass the test above for the wrong
    // reason, quietly, the day the directive or the layout changes.
    expect(clients.filter(Boolean).length).toBeGreaterThan(5);
  });

  it('follows a chain rather than reading one file', async () => {
    // The check's own claim, tested. `import-actions` is a Server Action that
    // imports core, and `errors.ts` behind it does too - so a walk that
    // stopped at the directive would report every screen in the application.
    const importer = join(WEB, 'app', 'app', 'import', 'importer.tsx');
    const reached = await localImports(importer, await readFile(importer, 'utf8'));

    expect(reached.some((path) => path.endsWith('mapping.tsx'))).toBe(true);
    // And it stops at a Server Action, which is where the bundle stops too.
    const actions = join(WEB, 'server', 'import-actions.ts');
    expect(await localImports(actions, await readFile(actions, 'utf8'))).toEqual([]);
  });
});
