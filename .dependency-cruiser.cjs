/**
 * Architecture enforcement (FBL-010 section C) — executed by `npm run architecture:check`
 * and in CI.
 *
 * The per-package allowed-dependency rules are DERIVED from architecture/modules.json at
 * load time, so the ownership map and the checker cannot drift apart; the manifest
 * itself is validated against the real workspace package.json files by
 * scripts/check-architecture-manifest.ts.
 */
const { modules } = require('./architecture/modules.json');

// One forbidden-rule per module: it may only depend on its declared @dealer/* set.
const dealerNames = Object.keys(modules);
const perModuleRules = Object.entries(modules).map(([name, meta]) => {
  const allowed = new Set(meta.allowedDealerDeps);
  const forbidden = dealerNames.filter((other) => other !== name && !allowed.has(other));
  return {
    name: `deps-of-${name.replace('@dealer/', '')}`,
    comment: `${name} may only depend on: ${meta.allowedDealerDeps.join(', ') || '(no @dealer packages)'} (architecture/modules.json)`,
    severity: 'error',
    from: { path: `^${meta.path}/src` },
    to: {
      path:
        forbidden.length > 0
          ? `^(${forbidden.map((n) => modules[n].path).join('|')})/src`
          : '^$__never__',
    },
  };
});

module.exports = {
  forbidden: [
    ...perModuleRules,
    {
      name: 'no-outside-deep-import-into-packages',
      comment:
        'Any file that is not itself package src code — fixtures, tests, scripts, stray ' +
        'in-package tooling — may not reach into package src internals. The negative ' +
        'fixture (architecture/fixtures) is rejected by exactly this rule; src-to-src ' +
        'traffic is governed by no-cross-package-deep-import above.',
      severity: 'error',
      from: { pathNot: '^(apps|packages)/[^/]+/src/' },
      to: { path: '^packages/[^/]+/src/(?!index[.]ts$).+' },
    },
    {
      name: 'workos-sdk-confined-to-adapter',
      comment:
        'The WorkOS SDK is a provider detail: only the adapter directory ' +
        '(packages/identity-access/src/provider/workos) may import @workos-inc/node. ' +
        'Everything else — including the rest of identity-access — stays provider-neutral.',
      severity: 'error',
      from: { pathNot: '^packages/identity-access/src/provider/workos/' },
      to: { path: '^node_modules/@workos-inc/node' },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies anywhere in the workspace.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-cross-package-deep-import',
      comment:
        'Packages are consumed through their public entry point (src/index.ts) only. ' +
        "Reaching into another package's src tree — including its persistence internals — is prohibited.",
      severity: 'error',
      from: { path: '^(apps|packages)/([^/]+)/src' },
      to: {
        path: '^(apps|packages)/([^/]+)/src/.+',
        pathNot: [
          '^(apps|packages)/$2/src/.+', // own package: free
          '^(apps|packages)/([^/]+)/src/index\\.ts$', // public entry: fine
        ],
      },
    },
    {
      name: 'domain-is-pure',
      comment:
        'Domain rules import no transport, database, metrics, filesystem or network code — ' +
        'and no other package at all except contracts.',
      severity: 'error',
      from: { path: '^packages/fixed-ops/src/domain' },
      to: {
        path: '^(node_modules/(express|pg|prom-client)|packages/(database|platform)/src)',
      },
    },
    {
      name: 'domain-no-node-runtime',
      comment: 'Domain rules stay computational: no fs/net/http/child_process.',
      severity: 'error',
      from: { path: '^packages/fixed-ops/src/domain' },
      to: { path: '^(fs|net|http|https|child_process|dns|tls)$', dependencyTypes: ['core'] },
    },
    {
      name: 'apps-no-direct-pg',
      comment:
        'Apps are composition roots: they wire @dealer/database but never speak to pg ' +
        'directly and never carry SQL.',
      severity: 'error',
      from: { path: '^apps/[^/]+/src' },
      to: { path: '^node_modules/pg(/|$)' },
    },
    {
      name: 'no-test-kit-in-production',
      comment: '@dealer/test-kit is test-only: production packages and apps never import it.',
      severity: 'error',
      from: { path: '^(apps|packages)/(?!test-kit)[^/]+/src' },
      to: { path: '^packages/test-kit' },
    },
    {
      name: 'contracts-stay-neutral',
      comment: '@dealer/contracts depends on no framework, driver, or other package.',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { path: '^(node_modules/(express|pg|prom-client)|apps/|packages/(?!contracts))' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['main', 'types'],
    },
    exclude: { path: '\\.d\\.ts$' },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
