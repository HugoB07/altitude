/**
 * The id of the reader that has no reader until somebody describes their file.
 *
 * A mirror of `CUSTOM_PRESET_ID` in `@altitude/core`, and a test asserts the
 * two are equal. Both sides need it: the registry builds the synthetic preset
 * from a mapping, and the client screen tests against it to know when to ask
 * for one. Imported from core, the client would pull in the readers, which pull
 * in the database driver - and the build stops at "can't resolve 'fs'".
 *
 * Its own module with no imports, so nothing else comes with it.
 */
export const CUSTOM_PRESET_ID = 'custom';
