// @ccsm/proto ESLint flat config — extends repo root config and adds
// per-package boundary rules per design spec ch11 §5.
//
// Boundary intent: @ccsm/proto is the leaf package. It defines schemas and
// generated Connect-RPC code; it MUST NOT import from any other internal
// @ccsm/* package (no cycles, no runtime coupling). Generated code under
// packages/proto/gen/** is allowed to depend only on @bufbuild/* runtime.
import rootConfig from '../../eslint.config.js';

export default [
  ...rootConfig,
  {
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@ccsm/daemon', '@ccsm/daemon/*', '@ccsm/electron', '@ccsm/electron/*'],
            message: '@ccsm/proto is a leaf package — it MUST NOT import from any other @ccsm/* package (chapter 11 §5).'
          }
        ]
      }]
    }
  }
];
