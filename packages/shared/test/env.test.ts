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
