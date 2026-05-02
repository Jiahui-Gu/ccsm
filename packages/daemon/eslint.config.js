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
// Downstream tasks plug additional custom rules onto this same config:
//   - Task #29 (T1.9) adds `ccsm/no-listener-slot-mutation`
//     (listener-A descriptor slot mutability lint).
import rootConfig from '../../eslint.config.js';

export default [
  ...rootConfig,
  {
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
        ]
      }]
    }
  }
];
