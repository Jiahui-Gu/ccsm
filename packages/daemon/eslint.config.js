// @ccsm/daemon ESLint flat config — extends repo root config and adds
// per-package boundary rules per design spec ch11 §5.
//
// Boundary intent (spec ch11 §5 / ch15 §1 invariant 11):
//   - Daemon is headless. UI deps (electron / react / react-dom) and the
//     sibling @ccsm/electron package are forbidden imports.
//   - Daemon may consume @ccsm/proto, but only the GENERATED Connect-RPC
//     code under packages/proto/gen/**, not the raw .proto sources under
//     packages/proto/src/**.
//
// Custom rules:
//   - Task #29 (T1.9) `ccsm/no-listener-slot-mutation` — forbids
//     source-level mutation of the listener 2-tuple (slot 1 is pinned to
//     RESERVED_FOR_LISTENER_B until v0.4). The rule is bypassed for
//     `**/listener-b.ts` (the single v0.4 file allowed to publish into
//     slot 1) via a trailing override block. Bypass surface is grep-able
//     here so reviewers can audit it as a single point.
//   - Task #430 (#230-6 / P24) `ccsm/no-client-kind-branch` — forbids
//     daemon control-flow branching on `HelloRequest.client_kind` /
//     `HelloResponse.listener_id` (open-string observability fields per
//     spec ch15 §3 #24). Read for logging / metrics is allowed; only
//     `switch (req.client_kind)` and `req.client_kind === 'X'` /
//     `req.listener_id !== 'A'` style branches are flagged. Scoped to
//     `packages/daemon/src/**` via a trailing override block.
import rootConfig from '../../eslint.config.js';
import ccsmListenerSlotPlugin from './eslint-plugins/ccsm-no-listener-slot-mutation.js';
import ccsmNoClientKindBranchPlugin from './eslint-plugins/ccsm-no-client-kind-branch.js';

// Combine local plugin rules under a single `ccsm` namespace so the
// flat config exposes them as `ccsm/<rule-name>` to ESLint.
const ccsmPlugin = {
  meta: { name: 'ccsm', version: '0.1.0' },
  rules: {
    ...ccsmListenerSlotPlugin.rules,
    ...ccsmNoClientKindBranchPlugin.rules,
  },
};

export default [
  ...rootConfig,
  {
    plugins: {
      ccsm: ccsmPlugin,
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@ccsm/electron', '@ccsm/electron/*'],
            message: '@ccsm/daemon MUST NOT import from @ccsm/electron (chapter 11 §5).'
          },
          {
            group: ['electron', 'electron/*', 'react', 'react-dom'],
            message: '@ccsm/daemon is headless — UI deps forbidden (chapter 11 §5).'
          },
          {
            group: ['@ccsm/proto/src/*', '@ccsm/proto/src'],
            message: '@ccsm/daemon may only import generated Connect-RPC code from @ccsm/proto/gen/**, not raw .proto sources (chapter 11 §5).'
          }
        ],
      }],
      'ccsm/no-listener-slot-mutation': 'error',
    },
  },
  {
    // ccsm/no-client-kind-branch is scoped to daemon source — tests
    // and eslint-plugins/** don't need the guard (and the spec
    // fixtures intentionally exercise the very patterns the rule
    // forbids).
    files: ['src/**/*.ts'],
    rules: {
      'ccsm/no-client-kind-branch': 'error',
    },
  },
  {
    // v0.4 carve-out: the Listener B factory is the single file allowed
    // to publish a real listener into slot 1. Keep the bypass narrow —
    // any other file matching this glob would be a spec violation.
    files: ['**/listener-b.ts'],
    rules: {
      'ccsm/no-listener-slot-mutation': 'off',
    },
  },
];
