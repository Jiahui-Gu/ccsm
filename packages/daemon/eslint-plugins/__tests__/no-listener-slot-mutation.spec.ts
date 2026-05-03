// Spec for the local ESLint plugin `ccsm/no-listener-slot-mutation`.
// Covers spec ch03 §1 (slot 1 immutability) + ch11 §5 (lint-time guard).
//
// We use ESLint's built-in `RuleTester` (no @typescript-eslint/rule-tester
// dependency). The rule is purely syntactic — it inspects identifier
// names and member-access shape — so the default espree parser is enough
// for the JS-shaped fixtures below. A small @typescript-eslint/parser
// suite at the bottom proves the rule works on TS source as it appears
// in `packages/daemon/src/**/*.ts`.

import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { rule } from '../ccsm-no-listener-slot-mutation.js';

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

describe('ccsm/no-listener-slot-mutation', () => {
  it('runs RuleTester (default parser)', () => {
    tester.run('no-listener-slot-mutation', rule, {
      valid: [
        // 1. Slot 0 write is fine — only slot 1 is reserved.
        { code: 'const slots = [a, b]; slots[0] = makeListenerA();' },
        // 2. Reading slot 1 is allowed (assertSlot1Reserved does this).
        { code: 'const slots = [a, b]; if (slots[1] !== SENTINEL) {}' },
        // 3. Assigning to a non-listener array is unrelated.
        { code: 'const queue = []; queue[1] = 42; queue.push(1);' },
        // 4. Mutating method on a non-listener identifier is unrelated.
        { code: 'const items = []; items.push(x); items.splice(0, 1);' },
        // 5. Method call that is not a mutator on a listener tuple is OK.
        { code: 'const listeners = [a, b]; listeners.map(l => l.id);' },
      ],
      invalid: [
        // 1. Direct slot-1 write on `listeners`.
        {
          code: 'const listeners = [a, b]; listeners[1] = makeListenerB();',
          errors: [{ messageId: 'slotAssign' }],
        },
        // 2. Direct slot-1 write on `slots` (heuristic name match).
        {
          code: 'const slots = [a, b]; slots[1] = realB;',
          errors: [{ messageId: 'slotAssign' }],
        },
        // 3. Mutating `push` on a listener-named array.
        {
          code: 'const listenerSlots = [a, b]; listenerSlots.push(c);',
          errors: [{ messageId: 'mutatingCall', data: { method: 'push' } }],
        },
        // 4. Mutating `splice` on a listener tuple via property chain.
        {
          code: 'env.listeners.splice(1, 1, makeListenerB());',
          errors: [{ messageId: 'mutatingCall', data: { method: 'splice' } }],
        },
        // 5. Computed-index symbolic write — conservative match.
        {
          code: 'const listeners = [a, b]; const i = 1; listeners[i] = b2;',
          errors: [{ messageId: 'slotAssign' }],
        },
      ],
    });
  });

  it('runs RuleTester (typescript-eslint parser)', () => {
    tsTester.run('no-listener-slot-mutation', rule, {
      valid: [
        // TS-typed slot 0 write.
        {
          code: 'const slots: readonly [unknown, unknown] = [a, b]; const s = slots as any; s[0] = x;',
        },
        // TS file in listener-b.ts is whitelisted at flat-config layer,
        // not via parser; here we just prove the rule still rejects
        // the same pattern when run directly (whitelist is a config
        // concern verified in the eslint.config.js wiring).
      ],
      invalid: [
        {
          code: 'const listeners: any[] = []; listeners[1] = bListener as any;',
          errors: [{ messageId: 'slotAssign' }],
        },
      ],
    });
  });
});
