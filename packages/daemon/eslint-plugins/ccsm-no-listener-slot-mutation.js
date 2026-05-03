// Local ESLint plugin: ccsm/no-listener-slot-mutation
//
// Spec ch03 §1 (Listener trait + 2-slot tuple invariant) and ch11 §5
// (per-package boundary rules / lint-time guards). v0.3 ships exactly
// one active listener — slot 0 is Listener A; slot 1 is pinned to the
// `RESERVED_FOR_LISTENER_B` typed sentinel. The compile-time guard is
// the `ListenerSlots` readonly tuple shape (T1.2). The runtime guard
// is `assertSlot1Reserved` (T1.2). This module is the lint-time guard:
// it forbids any source-level write that would alter slot 1 (or
// otherwise mutate the listener-array shape) before v0.4 lands the
// real Listener B factory.
//
// Whitelist: the rule is bypassed by the per-package flat config for
// `**/listener-b.ts` — the single v0.4 file that is *expected* to
// publish a real listener into slot 1. The bypass lives in
// `packages/daemon/eslint.config.js` (flat-config `files`/`ignores`
// override) rather than as a rule option, so the bypass surface is
// auditable as a single grep target.
//
// Conservative heuristic: the rule fires only when the LHS object
// identifier name plausibly refers to a listener tuple. Matching is
// case-insensitive against the substrings "listener" or "slot". This
// avoids false positives on unrelated arrays while catching every
// realistic naming used in the daemon (`listeners`, `listenerSlots`,
// `daemonEnv.listeners`, `slots`, `env.listeners`, …).
//
// SRP: this module is a pure decider — it inspects AST nodes and
// reports. No I/O, no factories, no fixers. Auto-fix is intentionally
// not provided: every match here is a design-level violation that a
// human must justify (or the file must move under the listener-b.ts
// whitelist).

const LISTENER_NAME_RE = /listener|slot/i;

/**
 * Walks a MemberExpression's object chain to find a leaf identifier
 * name. Handles `slots`, `env.listeners`, `this.listenerSlots`, and
 * `daemonEnv.listeners[1]` style chains.
 */
function leafIdentifierName(node) {
  let cursor = node;
  while (cursor) {
    if (cursor.type === 'Identifier') return cursor.name;
    if (cursor.type === 'MemberExpression') {
      // Prefer the rightmost property name when it is a non-computed
      // identifier (e.g. `env.listeners` -> "listeners"). Otherwise
      // recurse into the object side.
      if (!cursor.computed && cursor.property && cursor.property.type === 'Identifier') {
        return cursor.property.name;
      }
      cursor = cursor.object;
      continue;
    }
    if (cursor.type === 'ThisExpression') return 'this';
    if (cursor.type === 'ChainExpression') {
      cursor = cursor.expression;
      continue;
    }
    return null;
  }
  return null;
}

function looksLikeListenerArray(objectNode) {
  const name = leafIdentifierName(objectNode);
  if (!name) return false;
  return LISTENER_NAME_RE.test(name);
}

/** True for `MemberExpression` of shape `<obj>[1]` (computed numeric 1). */
function isSlot1Access(node) {
  if (node.type !== 'MemberExpression') return false;
  if (!node.computed) return false;
  const p = node.property;
  if (!p) return false;
  // Literal 1
  if (p.type === 'Literal' && p.value === 1) return true;
  // Identifier (computed but symbolic) — be conservative and flag it
  // when the array name looks like a listener tuple, since the index
  // expression could resolve to slot 1 at runtime.
  if (p.type === 'Identifier') return true;
  // UnaryExpression like -0 etc. — ignore.
  return false;
}

const MUTATING_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'fill',
  'copyWithin',
  'sort',
  'reverse',
]);

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid source-level mutation of the daemon listener tuple (slot 1 is reserved for v0.4 Listener B). Spec ch03 §1.',
      recommended: true,
    },
    messages: {
      slotAssign:
        'Assignment to listener tuple slot is forbidden in v0.3 — slot 1 is pinned to RESERVED_FOR_LISTENER_B until v0.4 (spec ch03 §1). Listener B activation is the only exception and must live in `listener-b.ts`.',
      mutatingCall:
        'Calling `{{method}}()` on a listener tuple mutates the closed 2-slot shape (spec ch03 §1). Treat the tuple as readonly; reconstruct via factory if you really mean to change it.',
    },
    schema: [],
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        const left = node.left;
        if (!left || left.type !== 'MemberExpression') return;
        if (!isSlot1Access(left)) return;
        if (!looksLikeListenerArray(left.object)) return;
        context.report({ node, messageId: 'slotAssign' });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        if (callee.computed) return;
        if (!callee.property || callee.property.type !== 'Identifier') return;
        if (!MUTATING_METHODS.has(callee.property.name)) return;
        if (!looksLikeListenerArray(callee.object)) return;
        context.report({
          node,
          messageId: 'mutatingCall',
          data: { method: callee.property.name },
        });
      },
    };
  },
};

const plugin = {
  meta: { name: 'ccsm-no-listener-slot-mutation', version: '0.1.0' },
  rules: {
    'no-listener-slot-mutation': rule,
  },
};

export default plugin;
export { rule };
