import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { MissingConfigurationError, envFlag, optionalEnv, requireEnv } from '../src/env/index';

const VAR = 'ALTITUDE_TEST_ONLY_VARIABLE';

afterEach(() => {
  delete process.env[VAR];
});

describe('requireEnv', () => {
  it('returns the value when set', () => {
    process.env[VAR] = 'hello';
    expect(requireEnv(VAR)).toBe('hello');
  });

  it('throws when absent', () => {
    expect(() => requireEnv(VAR)).toThrow(MissingConfigurationError);
  });

  it('treats blank as absent', () => {
    // DATABASE_URL= in an env file is a variable someone meant to fill in,
    // not a deliberate empty string.
    process.env[VAR] = '   ';
    expect(() => requireEnv(VAR)).toThrow(MissingConfigurationError);
  });

  it('names the variable and points at .env.example', () => {
    try {
      requireEnv(VAR, 'Needed to reach the database.');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain(VAR);
      expect((error as Error).message).toContain('Needed to reach the database.');
      expect((error as Error).message).toContain('.env.example');
      expect((error as MissingConfigurationError).variable).toBe(VAR);
    }
  });
});

describe('optionalEnv', () => {
  it('falls back when absent or blank', () => {
    expect(optionalEnv(VAR, 'EUR')).toBe('EUR');
    process.env[VAR] = '';
    expect(optionalEnv(VAR, 'EUR')).toBe('EUR');
  });

  it('prefers the value when set', () => {
    process.env[VAR] = 'USD';
    expect(optionalEnv(VAR, 'EUR')).toBe('USD');
  });
});

describe('envFlag', () => {
  it('recognises the usual spellings of true', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
      process.env[VAR] = v;
      expect(envFlag(VAR)).toBe(true);
    }
  });

  it('treats anything else as false', () => {
    for (const v of ['false', '0', 'no', 'maybe', '']) {
      process.env[VAR] = v;
      expect(envFlag(VAR, true)).toBe(v === '' ? true : false);
    }
  });
});

/**
 * A rule nobody can enforce by remembering.
 *
 * `process.env.SOMETHING ?? 'literal'` turns a missing variable into a silent
 * connection to whatever the literal names - and for a credential, puts the
 * credential in the repository permanently, still working, so nobody notices.
 *
 * This walks the source and fails on the pattern. It belongs in a lint rule and
 * will move to one when ESLint lands; until then a test is what CI actually
 * runs, which makes it the enforcement that exists rather than the one planned.
 */
describe('no environment variable has a hardcoded fallback', () => {
  const ROOT = join(import.meta.dirname, '..', '..', '..');
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', 'coverage', 'docs']);

  async function sourceFiles(dir: string, found: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await sourceFiles(full, found);
      else if (/\.(ts|mts|mjs|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        found.push(full);
      }
    }
    return found;
  }

  /**
   * Comments are not code.
   *
   * Without this, documenting the forbidden pattern trips the check that
   * forbids it - which is how a guard trains people to weaken it. env.ts shows
   * the bad shape on purpose, and must be allowed to.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('finds none anywhere in the workspace', async () => {
    // process.env.NAME ?? '...' or process.env['NAME'] ?? '...', and the ||
    // spelling, across a line break or not.
    const pattern =
      /process\s*\.\s*env\s*(?:\.\s*\w+|\[\s*['"`]\w+['"`]\s*\])\s*(?:\?\?|\|\|)\s*['"`]/;

    const offenders: string[] = [];
    for (const file of await sourceFiles(ROOT)) {
      const contents = await readFile(file, 'utf8');
      if (pattern.test(stripComments(contents))) offenders.push(relative(ROOT, file));
    }

    expect(offenders, 'use requireEnv() - a missing variable must fail loudly').toEqual([]);
  });
});

/**
 * Every variable `.env.example` offers is one the code reads, or one it says is
 * not read yet.
 *
 * The file is the only place an operator learns what an instance can be told,
 * and it drifts in both directions. It carried `ALTITUDE_BASE_CURRENCY` for two
 * phases while the first-run wizard wrote `'EUR'` into its own source, so an
 * instance run from Zurich started every household in euros and the variable
 * that was supposed to fix that did nothing. Then, wiring it up, the file was
 * left saying it was read by nothing - twice, on the same file, in the same
 * hour. A person cannot hold this; a test can.
 *
 * A variable is allowed to be unread, because the plan specifies several that
 * belong to phases nobody has built (§14.1) and writing the default down is
 * itself the decision. What is not allowed is being unread quietly: it goes
 * under a section heading that says so, and the heading is what this reads.
 */
describe('.env.example', () => {
  const ROOT = join(import.meta.dirname, '..', '..', '..');
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', 'coverage', 'docs']);

  /**
   * Wider than the check above, on purpose. A variable consumed only by the
   * compose file or by CI is a variable that is used, and refusing to look at
   * yaml would file it as decoration.
   */
  async function readable(dir: string, found: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name === 'pnpm-lock.yaml') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await readable(full, found);
      else if (/\.(ts|mts|mjs|tsx|yml|yaml|json)$/.test(entry.name)) found.push(full);
    }
    return found;
  }

  /** Each variable the file declares, and whether its section says it is unread. */
  function declared(example: string): { name: string; reserved: boolean }[] {
    const found: { name: string; reserved: boolean }[] = [];
    let reserved = false;

    for (const line of example.split('\n')) {
      // A section heading, which is where the file says which half it is in.
      if (line.startsWith('# -- ')) reserved = line.toLowerCase().includes('reserved');

      const match = /^([A-Z0-9_]+)=/.exec(line);
      if (match !== null) found.push({ name: match[1]!, reserved });
    }

    return found;
  }

  it('offers nothing the code does not read, unless it says so', async () => {
    const variables = declared(await readFile(join(ROOT, '.env.example'), 'utf8'));
    expect(variables.length, 'parsed nothing, so the checks below mean nothing').toBeGreaterThan(5);

    const sources = await Promise.all((await readable(ROOT)).map((file) => readFile(file, 'utf8')));
    const used = (name: string) => sources.some((source) => source.includes(name));

    const undocumented = variables.filter((one) => !one.reserved && !used(one.name));
    const stale = variables.filter((one) => one.reserved && used(one.name));

    expect(
      undocumented.map((one) => one.name),
      'offered as configuration and read by nothing - wire it up, or file it under a "Reserved" heading',
    ).toEqual([]);

    expect(
      stale.map((one) => one.name),
      'filed as unread and read after all - move it out of the "Reserved" section',
    ).toEqual([]);
  });
});
