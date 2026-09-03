/**
 * `server-only`, for a test runner that is neither a server nor a client.
 *
 * The real package resolves to a module that throws unless the bundler asks for
 * its `react-server` condition, which is exactly the guard we want in the
 * application and exactly what stops a unit test importing anything behind it.
 * Aliased in `vitest.config.mts` so a module can keep the guard and still be
 * tested; nothing else about the module changes.
 */
export {};
