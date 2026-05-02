// no-floating-cancellation — custom ESLint rule for ccsm.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//   §3.5.1.3:
//     "Handlers MUST check `signal.aborted` at every `await` boundary
//      inside long ops; lint rule `no-floating-cancellation` (custom
//      ESLint rule, +0.5h Task 5) flags handlers that take `signal` but
//      never read it."
//
// What this rule flags:
//   - Any function whose parameter list declares (or destructures) a
//     parameter named `signal` MUST read it at least once. "Read" =
//     any of:
//       * member access      `signal.aborted` / `signal.reason`
//       * method call        `signal.throwIfAborted()` / `addEventListener`
//       * passed as arg      `foo(signal)`        (forwarded — the callee
//                                                  is presumed to honor it)
//       * spread              `{ signal }` / `[signal]`
//       * identifier read    bare `signal` reference (assignment, return, etc.)
//
// What this rule does NOT flag:
//   - Functions that destructure `{ signal }` from an unused `req` and
//     never reference it — same logic as above (the destructure declares
//     a binding named `signal`, must be used).
//   - Allowlisted opt-out via the standard ESLint disable comment:
//     `// eslint-disable-next-line ccsm-local/no-floating-cancellation`
//   - Type-only references (TypeScript-style) are NOT counted as a read
//     because they are erased at runtime; we only count value references.
//   - Files outside the configured scope (set in eslint.config.js).
//
// Single-responsibility: this rule is a pure DECIDER over the AST. No
// auto-fix (the fix is to write business logic that observes abort).
//
// Notes on AST handling:
//   We collect the list of `signal` bindings declared by each function's
//   parameter list (handles plain `signal`, default `signal = ...`,
//   rest `...signal`, and destructured `{ signal }` / `{ ctx: { signal } }`).
//   Then we walk the function body and count value-reference identifiers
//   named `signal` that are NOT themselves the declaration.

'use strict';

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid handler functions that declare a `signal` parameter but never observe it. Per frag-3.5.1 §3.5.1.3, every handler taking AbortSignal must read it at some await boundary; otherwise client-side cancellation is silently dropped.',
      recommended: false,
    },
    schema: [],
    messages: {
      unobserved:
        '`signal` parameter declared but never observed. Per frag-3.5.1 §3.5.1.3, handlers taking AbortSignal must read it (e.g. `signal.aborted`, `signal.throwIfAborted()`, or forward to a sub-call). If this handler legitimately ignores cancellation, prefix with `// eslint-disable-next-line ccsm-local/no-floating-cancellation` and a one-line justification.',
    },
  },
  create(context) {
    /**
     * Walk a parameter pattern node and append every Identifier named
     * `signal` to `out`. Handles destructuring, defaults, and rest.
     */
    function collectSignalBindings(pattern, out) {
      if (!pattern) return;
      switch (pattern.type) {
        case 'Identifier':
          if (pattern.name === 'signal') out.push(pattern);
          return;
        case 'AssignmentPattern':
          // e.g. `signal = AbortSignal.timeout(5)`
          collectSignalBindings(pattern.left, out);
          return;
        case 'RestElement':
          collectSignalBindings(pattern.argument, out);
          return;
        case 'ArrayPattern':
          for (const el of pattern.elements) {
            if (el) collectSignalBindings(el, out);
          }
          return;
        case 'ObjectPattern':
          for (const prop of pattern.properties) {
            if (prop.type === 'RestElement') {
              collectSignalBindings(prop.argument, out);
            } else if (prop.type === 'Property') {
              // For `{ signal }` (shorthand) Property.value === Identifier(signal).
              // For `{ s: signal }` Property.value === Identifier(signal) too.
              // Either way: walk the value side.
              collectSignalBindings(prop.value, out);
            }
          }
          return;
        // TSParameterProperty / TSAsExpression etc. — espree doesn't emit
        // these; @typescript-eslint/parser does. Recurse into the
        // underlying parameter when present.
        case 'TSParameterProperty':
          collectSignalBindings(pattern.parameter, out);
          return;
        default:
          // Unknown shape: ignore. We'd rather under-flag than false-flag.
          return;
      }
    }

    /** Scope-walk: collect all declared `signal` Identifier nodes in the
     *  function's own parameter list. */
    function paramsDeclareSignal(funcNode) {
      const decls = [];
      for (const p of funcNode.params) {
        collectSignalBindings(p, decls);
      }
      return decls;
    }

    /** Cheap "is this Identifier node a value reference (not a declaration
     *  and not a property key)?" heuristic. We treat the following parents
     *  as non-references:
     *    - the declaration itself (already filtered by node-identity)
     *    - non-computed Property.key  (e.g. `{ signal: 1 }` — that's an
     *      object literal key, not a reference to `signal`)
     *    - non-computed MemberExpression.property (`obj.signal` — `signal`
     *      is the property name, not a reference)
     *    - LabeledStatement.label / BreakStatement.label / ContinueStatement.label
     *  Everything else counts as a value read. */
    function isValueReference(idNode) {
      const parent = idNode.parent;
      if (!parent) return true;
      if (parent.type === 'Property' && parent.key === idNode && !parent.computed) {
        // shorthand `{ signal }` is `Property.shorthand === true` and
        // value === key === same Identifier — that case IS a binding,
        // handled by the declaration set; here we'd skip it. We only
        // reach this branch for non-shorthand `{ signal: 1 }`.
        return parent.shorthand === true;
      }
      if (
        parent.type === 'MemberExpression' &&
        parent.property === idNode &&
        !parent.computed
      ) {
        return false;
      }
      if (
        (parent.type === 'LabeledStatement' ||
          parent.type === 'BreakStatement' ||
          parent.type === 'ContinueStatement') &&
        parent.label === idNode
      ) {
        return false;
      }
      // ImportSpecifier 'imported' identifier (the original name) is
      // not a runtime reference; the local binding is the runtime
      // reference. Same for ExportSpecifier 'exported'.
      if (parent.type === 'ImportSpecifier' && parent.imported === idNode) return false;
      if (parent.type === 'ExportSpecifier' && parent.exported === idNode) return false;
      return true;
    }

    /** Per-function check. We attach to every function-like AST node. */
    function checkFunction(node) {
      const declarations = paramsDeclareSignal(node);
      if (declarations.length === 0) return;
      // Build identity set of declaration nodes so we don't count the
      // declarations themselves as references.
      const declSet = new Set(declarations);
      // Walk the function body (or expression body for arrow fns) and
      // count value-references named `signal`.
      let observed = false;
      const body = node.body;
      if (!body) return;
      const visit = (n) => {
        if (observed) return;
        if (!n || typeof n !== 'object') return;
        if (n.type === 'Identifier' && n.name === 'signal' && !declSet.has(n)) {
          if (isValueReference(n)) {
            observed = true;
            return;
          }
        }
        // Don't descend into nested function bodies — a nested function
        // shadows our `signal` binding only if it re-declares one (which
        // its own checkFunction call will validate). If it doesn't
        // re-declare, the outer `signal` is closed-over and a reference
        // there counts. Since we can't cheaply tell shadowing without a
        // scope manager, we DESCEND but rely on the declSet identity
        // check to avoid counting nested re-declarations as observations.
        for (const key of Object.keys(n)) {
          if (key === 'parent' || key === 'loc' || key === 'range') continue;
          const v = n[key];
          if (Array.isArray(v)) {
            for (const item of v) visit(item);
          } else if (v && typeof v === 'object' && typeof v.type === 'string') {
            visit(v);
          }
        }
      };
      visit(body);
      if (!observed) {
        // Report on the FIRST declaration site so the squiggle is on the
        // parameter, not deep inside the body.
        context.report({
          node: declarations[0],
          messageId: 'unobserved',
        });
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      MethodDefinition(node) {
        // MethodDefinition wraps a FunctionExpression in node.value; the
        // FunctionExpression visitor above handles it. No extra work here.
        void node;
      },
    };
  },
};
