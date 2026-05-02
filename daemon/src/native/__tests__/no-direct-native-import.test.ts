// Unit tests for the custom ESLint rule no-direct-native-import.
//
// We exercise the rule via ESLint's RuleTester against synthetic
// import / require expressions instead of running eslint over real
// fixture files (cleaner, no fs touchpoints, no ignore-list
// complications).

// Unit tests for the custom ESLint rule no-direct-native-import.
//
// We exercise the rule via ESLint's RuleTester against synthetic
// import / require expressions instead of running eslint over real
// fixture files (cleaner, no fs touchpoints, no ignore-list
// complications).
//
// RuleTester.run calls `describe`/`it` internally so it MUST run at
// module top level, not inside another describe/it.

import { RuleTester } from 'eslint';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const require = createRequire(import.meta.url);
const rule = require(
  path.join(repoRoot, 'eslint-rules', 'no-direct-native-import.js'),
);

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-direct-native-import', rule, {
  valid: [
    {
      // arbitrary non-native import
      code: "import x from './foo.js';",
      filename: 'daemon/src/pty/win-jobobject.ts',
    },
    {
      // require of a non-.node thing
      code: "const x = require('./bar');",
      filename: 'daemon/src/pty/win-jobobject.ts',
    },
    {
      // shim file IS allowed to load .node
      code: "const x = require('./build/Release/ccsm_native.node');",
      filename: 'daemon/src/native/index.ts',
    },
    {
      code: "import x from './build/Release/ccsm_native.node';",
      filename: 'daemon/src/native/impl/napi.ts',
    },
  ],
  invalid: [
    {
      code: "import x from './ccsm_native.node';",
      filename: 'daemon/src/pty/lifecycle.ts',
      errors: [{ messageId: 'directImport' }],
    },
    {
      code: "const x = require('./build/Release/ccsm_native.node');",
      filename: 'daemon/src/sockets/control-socket.ts',
      errors: [{ messageId: 'directImport' }],
    },
    {
      code: "const path = require.resolve('../native/ccsm_native.node');",
      filename: 'daemon/src/pty/fanout-registry.ts',
      errors: [{ messageId: 'directImport' }],
    },
    {
      // any path containing ccsm_native (including index re-exports
      // typed as ccsm_native/something)
      code: "import x from '../ccsm_native/binding';",
      filename: 'daemon/src/pty/win-jobobject.ts',
      errors: [{ messageId: 'directImport' }],
    },
    {
      // dynamic import
      code: "const m = await import('./ccsm_native.node');",
      filename: 'daemon/src/pty/lifecycle.ts',
      errors: [{ messageId: 'directImport' }],
    },
  ],
});
