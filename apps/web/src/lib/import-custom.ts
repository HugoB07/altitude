/**
 * The id of the reader that has no reader until somebody describes their file.
 *
 * Its own module, with no imports, because both sides need it: the preset
 * registry builds the synthetic preset, and the client screen tests against it
 * to know when to ask for a mapping. Taken from the registry, the client would
 * pull in the readers, which pull in `@altitude/core`, which pulls in the
 * database driver - and the build stops at "can't resolve 'fs'".
 */
export const CUSTOM_PRESET_ID = 'custom';
