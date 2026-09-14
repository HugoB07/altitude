import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * CI runs `test:coverage` and `test:db`, never `pnpm test`.
 *
 * So the two halves have to name, between them, every directory `pnpm test`
 * would run - and when they do not, the gap is silent in the only way that
 * matters: the missing suite still passes on a clone, so nobody finds out.
 *
 * That is not hypothetical. `test:coverage` repeated `test:unit`'s list of
 * paths and left out `apps/web/test`, so nine guards - the client/server
 * boundary among them - were never run by CI for as long as the script existed.
 *
 * This reads the scripts rather than running them. Three more vitest processes
 * to answer a question about two strings is not a trade worth making, and the
 * cost is that this proves every directory is named by a half, not that vitest
 * then selects the files inside it that we think it does.
 *
 * It lives here rather than in `apps/web/test` on purpose: a guard about which
 * directories CI runs must not sit in a directory CI might stop running.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Every `test` directory `vitest.config.mts` would include, found on disk. */
async function testDirectories(): Promise<string[]> {
  const found: string[] = [];
  for (const group of ['packages', 'apps']) {
    for (const entry of await readdir(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${group}/${entry.name}/test`;
      if (existsSync(join(ROOT, directory))) found.push(directory);
    }
  }
  return found;
}

async function scripts(): Promise<Record<string, string>> {
  const manifest: unknown = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return (manifest as { scripts: Record<string, string> }).scripts;
}

describe('the two halves CI runs', () => {
  it('found the directories to check, so an empty pass is not a pass', async () => {
    expect((await testDirectories()).length).toBeGreaterThanOrEqual(4);
  });

  it('name every test directory between them', async () => {
    const { 'test:unit': unit, 'test:db': db } = await scripts();
    const halves = `${unit} ${db}`;

    for (const directory of await testDirectories()) {
      // A vitest positional filter is a substring of the path, so a script may
      // name the package (`packages/core`) or the directory (`apps/web/test`).
      const asPackage = directory.slice(0, directory.lastIndexOf('/'));
      expect(halves.includes(directory) || halves.includes(asPackage), directory).toBe(true);
    }
  });

  it('put the database files in exactly one of them', async () => {
    // Both directions. Without the exclusion they run twice, once without a
    // database; without the filter they run nowhere.
    const { 'test:unit': unit, 'test:db': db } = await scripts();
    expect(unit).toContain('--exclude "**/*.db.test.ts"');
    expect(db).toContain('.db.test.ts');
  });

  it('measure coverage over the unit run rather than a second copy of its paths', async () => {
    // The shape that caused the gap: two lists that had to agree and did not.
    expect((await scripts())['test:coverage']).toContain('pnpm test:unit');
  });
});
