// Spec for the local ESLint plugin `ccsm/no-client-kind-branch`.
// Covers spec ch15 §3 #24 — `HelloRequest.client_kind` and
// `HelloResponse.listener_id` are open-string observability fields;
// daemon MUST NOT branch on them. Reads (logging / debug) are allowed.
//
// Mirrors the shape of `no-listener-slot-mutation.spec.ts`: ESLint's
// built-in RuleTester for default-parser fixtures, plus a tiny
// `@typescript-eslint/parser` suite to prove the rule works against TS
// source as it appears in `packages/daemon/src/**/*.ts`.

import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { rule } from '../ccsm-no-client-kind-branch.js';

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

describe('ccsm/no-client-kind-branch', () => {
  it('runs RuleTester (default parser)', () => {
    tester.run('no-client-kind-branch', rule, {
      valid: [
        // 1. Pure read into a logger payload — observability, allowed.
        { code: 'log.info({client_kind: req.client_kind});' },
        // 2. Read into a local — no control-flow gate.
        { code: 'const k = req.client_kind;' },
        // 3. Read of listener_id into a metric tag.
        { code: 'metrics.tag("lid", res.listener_id);' },
        // 4. Branch on an unrelated field is fine.
        { code: 'if (req.principal === "owner") { doThing(); }' },
        // 5. switch on an unrelated field is fine.
        { code: 'switch (req.proto_version) { case 1: break; }' },
        // 6. Comparing an unrelated property named similarly is unrelated.
        { code: 'if (req.client_kind_label === "ui") {}' },
      ],
      invalid: [
        // 1. switch on req.client_kind — classic violation.
        {
          code: "switch (req.client_kind) { case 'electron': break; }",
          errors: [{ messageId: 'switchBranch', data: { prop: 'client_kind' } }],
        },
        // 2. switch on res.listener_id.
        {
          code: "switch (res.listener_id) { case 'A': break; }",
          errors: [{ messageId: 'switchBranch', data: { prop: 'listener_id' } }],
        },
        // 3. if (req.client_kind === 'electron') — comparison branch.
        {
          code: "if (req.client_kind === 'electron') { doElectron(); }",
          errors: [{ messageId: 'compareBranch', data: { prop: 'client_kind' } }],
        },
        // 4. Reverse-order comparison ('A' === res.listener_id).
        {
          code: "if ('A' === res.listener_id) { doA(); }",
          errors: [{ messageId: 'compareBranch', data: { prop: 'listener_id' } }],
        },
        // 5. Ternary / ConditionalExpression branch.
        {
          code: "const x = req.client_kind === 'cli' ? 1 : 2;",
          errors: [{ messageId: 'compareBranch', data: { prop: 'client_kind' } }],
        },
        // 6. !== inequality also counts as control-flow gating.
        {
          code: "if (req.client_kind !== 'electron') { fallback(); }",
          errors: [{ messageId: 'compareBranch', data: { prop: 'client_kind' } }],
        },
      ],
    });
  });

  it('runs RuleTester (typescript-eslint parser)', () => {
    tsTester.run('no-client-kind-branch', rule, {
      valid: [
        // TS-typed read into logger — observability allowed.
        {
          code: 'const req = {} as { client_kind: string }; log.info({client_kind: req.client_kind});',
        },
      ],
      invalid: [
        {
          code: "const req = {} as { client_kind: string }; if (req.client_kind === 'electron') { doIt(); }",
          errors: [{ messageId: 'compareBranch', data: { prop: 'client_kind' } }],
        },
        {
          code: "const res = {} as { listener_id: string }; switch (res.listener_id) { case 'A': break; }",
          errors: [{ messageId: 'switchBranch', data: { prop: 'listener_id' } }],
        },
      ],
    });
  });
});
