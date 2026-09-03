import { describe, expect, it } from 'vitest';
import { CUSTOM_PRESET_ID as CORE } from '@altitude/core';
import { CUSTOM_PRESET_ID as WEB } from '../src/lib/import-custom';

/**
 * One constant, written twice, kept equal here.
 *
 * The import screen is a client component and has to know when a file needs a
 * mapping, which is when the chosen preset is the custom one. It cannot import
 * the registry to find out: the registry reaches the readers, which reach
 * `@altitude/core`, which reaches the database driver, and the build stops at
 * "can't resolve 'fs'" (see `client-boundary.test.ts`).
 *
 * So the id lives in a module of its own on the web side, and this is the only
 * thing standing between that copy and the day somebody changes one of them.
 * The failure it prevents is quiet: the screen would simply stop offering a
 * mapping for a file no preset reads, and every unknown bank would look broken.
 */
describe('the custom preset id', () => {
  it('says the same thing on both sides of the bundler', () => {
    expect(WEB).toBe(CORE);
  });
});
