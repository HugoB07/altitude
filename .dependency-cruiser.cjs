/**
 * Machine-checks the architectural boundaries the ADRs describe.
 *
 * A rule here is worth more than a paragraph in ARCHITECTURE.md: the paragraph
 * gets out of date silently, this fails the build.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-is-framework-free',
      severity: 'error',
      comment:
        'packages/core is the domain: no React, no Next, no HTTP. It must be testable ' +
        'in milliseconds with no browser and no server (plan §4.5). If Next changes ' +
        'paradigm, we rewrite apps/web, not the business logic.',
      from: { path: '^packages/core/src' },
      to: { path: 'node_modules/(react|react-dom|next)(/|$)' },
    },
    {
      name: 'shared-depends-on-nothing-internal',
      severity: 'error',
      comment:
        'packages/shared is the base of the dependency graph. If it starts importing ' +
        'core or db, the graph has a cycle waiting to happen.',
      from: { path: '^packages/shared/src' },
      to: { path: '^packages/(core|db|importers|connectors|ui)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make module initialisation order load-bearing.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'A module nothing imports is either dead code or a missing export.',
      from: { orphan: true, pathNot: ['\.d\.ts$', '(^|/)index\.ts$', '\.config\.(m)?[tj]s$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    exclude: { path: '(^|/)(test|dist|\.next|\.turbo)(/|$)' },
  },
};
