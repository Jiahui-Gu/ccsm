// Tests for the no-floating-cancellation custom ESLint rule.
//
// RuleTester emits its own describe/it via the host test runner; we plug
// vitest's globals (describe/it) into it via the constructor option.

import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
// CommonJS rule loaded via require — same pattern as no-direct-native-import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../../eslint-rules/no-floating-cancellation.js');

// Plug vitest's describe/it into RuleTester's own dispatcher so its
// generated assertions show up as proper test cases.
RuleTester.describe = describe as unknown as typeof RuleTester.describe;
RuleTester.it = it as unknown as typeof RuleTester.it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

tester.run('no-floating-cancellation', rule, {
  valid: [
    // Function reads `signal.aborted`.
    { code: 'function h(req, signal) { if (signal.aborted) return; }' },
    // Forwarded to a sub-call.
    { code: 'function h(req, signal) { return inner(signal); }' },
    // Destructured + read.
    { code: 'function h({ signal }) { signal.throwIfAborted(); }' },
    // Doesn't take a `signal` parameter at all — rule has nothing to check.
    { code: 'function h(req) { return req.id; }' },
    // Arrow form.
    { code: 'const h = (signal) => { signal.addEventListener("abort", () => {}); };' },
    // Param named `_signal` (different name) — out of scope.
    { code: 'function h(_signal) { return 1; }' },
    // No `signal` param at all → must be valid.
    { code: 'function h(req) { return req.signal; }' },
  ],
  invalid: [
    {
      code: 'function h(req, signal) { return req.id; }',
      errors: [{ messageId: 'unobserved' }],
    },
    {
      code: 'function h({ signal }) { return 42; }',
      errors: [{ messageId: 'unobserved' }],
    },
    {
      code: 'function h(signal) { const x = obj.signal; return x; }',
      errors: [{ messageId: 'unobserved' }],
    },
  ],
});
