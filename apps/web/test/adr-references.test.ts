import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every ADR the code cites either exists or is reserved.
 *
 * `ADR-0011` was referenced from a migration and a schema file for a fortnight
 * before the document existed: a reader following it found nothing, and the
 * decision it named lived only in a comment. The numbers the plan reserves
 * (§3) are cited on purpose before they are written - the README says so - so
 * the check accepts those and refuses anything else.
 *
 * Housed here rather than in a package because it is about the repository, not
 * about the web application. This is the only directory the test runner already
 * looks at that is not a package's own; a `test/` at the root would be tidier
 * and is not worth a second entry in the runner's configuration for one file.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SEARCHED = ['packages', 'apps', 'docs'];

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (/\.(ts|tsx|sql|md)$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('ADR references', () => {
  it('point at a document that exists, or at a number the plan reserves', async () => {
    const written = new Set(
      (await readdir(join(ROOT, 'docs', 'adr')))
        .map((name) => /^(\d{4})-/.exec(name)?.[1])
        .filter((number): number is string => number !== undefined),
    );

    // Written when the code that depends on them is built, and cited before
    // that on purpose. The README's own table is the source of this list.
    const reserved = new Set(['0003', '0004', '0008']);

    const dangling = new Set<string>();
    for (const dir of SEARCHED) {
      for (const path of await files(join(ROOT, dir))) {
        const contents = await readFile(path, 'utf8');
        for (const match of contents.matchAll(/ADR-(\d{4})/g)) {
          const number = match[1]!;
          if (!written.has(number) && !reserved.has(number)) {
            dangling.add(`${number} (in ${path.slice(ROOT.length + 1)})`);
          }
        }
      }
    }

    expect([...dangling]).toEqual([]);
  });

  it('finds references at all, so a passing result means something', async () => {
    const contents = await readFile(
      join(ROOT, 'packages', 'core', 'src', 'services', 'transactions.ts'),
      'utf8',
    );
    expect(contents).toMatch(/ADR-\d{4}/);
  });
});
