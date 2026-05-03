// Regression spec: the daemon entrypoint must NOT grow the shutdown
// context's listener array via `.push()`. Spec ch03 §1 + spec
// forbidden-pattern #18: the listener tuple is a closed 2-slot shape;
// `.push()` is statically forbidden by ESLint
// (`ccsm/no-listener-slot-mutation`). This test is the behavior-level
// backstop for the lint rule — it asserts the contract by reading the
// entrypoint source and confirming `listeners.push(` is absent at the
// shutdown-context registration site.
//
// Why a source-text scan rather than a runtime test: the entrypoint
// `main()` boots a real daemon (binds Listener A, opens SQLite, etc.)
// and is not unit-testable as a function call. The lint rule is the
// primary gate; this test ensures the gate remains green by failing
// loudly the moment a regression introduces another `.push()` against
// any object whose name matches the listener-tuple naming convention.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, '..', '..', 'index.ts');

describe('daemon entrypoint listener-slot mutation contract', () => {
  it('never calls a mutating method on the listeners tuple', () => {
    const src = readFileSync(indexPath, 'utf8');
    // Strip /* ... */ block comments and // line comments so that
    // documentation prose (e.g. "we REASSIGN `listeners` rather than
    // calling `.push()`") cannot trip the regex.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // Mirror the ESLint rule's mutating-method set so the two stay in
    // sync (spec ch03 §1 — closed 2-slot shape).
    const mutators = ['push', 'pop', 'shift', 'unshift', 'splice', 'fill', 'copyWithin', 'sort', 'reverse'];
    for (const m of mutators) {
      const re = new RegExp(`\\b(?:listeners|listenerSlots|slots)\\b\\s*\\.\\s*${m}\\s*\\(`);
      expect(stripped, `daemon entrypoint must not call .${m}() on the listener tuple`).not.toMatch(re);
    }
  });

  it('reassigns ctxRef.listeners as a fresh tuple instead of mutating', () => {
    const src = readFileSync(indexPath, 'utf8');
    // The replacement contract: a single assignment of the form
    // `ctxRef.listeners = [listenerA]`. This is the only shape the
    // shutdown step (which iterates `for (const l of ctx.listeners)`)
    // accepts without iterating the typed sentinel from slot 1.
    expect(src).toMatch(/ctxRef\.listeners\s*=\s*\[\s*listenerA\s*\]/);
  });
});
