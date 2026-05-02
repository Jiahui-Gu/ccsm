// no-handler-without-check — custom ESLint rule for ccsm.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//   §3.4.1.d (Schema validation hook):
//     "For `payloadType === \"json\"` frames whose handler argument is
//      non-trivial, handlers MUST `Check(MethodArgsSchema, decoded)` as
//      their first statement. ESLint rule `no-handler-without-check`
//      enforces this at lint time."
//     "For `payloadType === \"binary\"` frames, handlers MUST validate
//      the trailer bytes against a per-method byte schema as their
//      first statement."
//
// Scope:
//   Lints functions located under `daemon/src/handlers/**` that look
//   like envelope handlers — i.e. they:
//     (a) take a request as the first parameter, AND
//     (b) are exported as a top-level `handle*` / `make*Handler` /
//         `create*Handler` factory result, OR
//     (c) are passed to `dispatcher.register('method', fn)` /
//         `registerHandler(...)` / similar.
//
//   Heuristic but high-precision: opting out is explicit, not by
//   accident.
//
// Ground truth (handlers grepped from daemon/src/handlers/ at rule
// authoring time):
//   - daemon-hello.ts          → `validateHelloRequest(req)` first stmt.
//   - daemon-shutdown-for-upgrade.ts → `planShutdownForUpgrade(req, ctx)`.
//   - daemon-shutdown.ts       → idempotency gate then reads `req?.deadlineMs`.
//   - healthz.ts / stats.ts    → take `_req: unknown` (payload-empty RPCs).
//   - pty-subscribe.ts         → unary fallback ignores `_req`; the real
//                                streaming path (`handlePtySubscribe`)
//                                validates `req.ptyId` via the injected
//                                `isValidPtyId` predicate.
//
// Opt-out signals (rule does NOT report):
//   1. The first parameter is named with a leading underscore
//      (`_req`, `_`, `_payload`, ...). This is the universal TS/ESLint
//      convention for "intentionally unused" — the handler does not
//      consume a payload, so there is nothing to validate.
//   2. The function or its enclosing factory carries a JSDoc tag
//      `@envelope-check-exempt` with a reason. Use this for streaming
//      acks / probe stubs whose req is opaque by design.
//
// Recognised validators (any of these as a `CallExpression` named in
// the body's first executable statement counts as a check):
//   - `Check(...)`                         (TypeBox)
//   - `Value.Check(...)`                   (TypeBox alt API)
//   - `assertEnvelope*(...)` / `assert*Envelope*(...)`
//   - `validate*(...)` / `parse*(...)`     (handler-supplied validator)
//   - `<anything>.check(...)` / `.parse(...)` / `.validate(...)`
//   - `envelope.check(...)`                (literal spec wording)
//   - `plan*(req, ...)`                    (the planner pattern used by
//                                           daemon-shutdown-for-upgrade —
//                                           the planner owns validation
//                                           and throws on bad input)
//
// Single-responsibility:
//   - DECIDER: visits handler-shaped function declarations / expressions,
//     decides whether the body opens with a recognised validator call.
//   - SINK: emits one `report({ messageId })` per offending handler. No
//     auto-fix (the fix is to add the project-specific Check call).
//
// Path scope:
//   By default this rule only fires when the file path matches
//   `daemon/src/handlers/`. Tests pass `filename` directly so the rule
//   can be exercised with synthetic source.

'use strict';

const HANDLER_PATH_RE = /[\\/]daemon[\\/]src[\\/]handlers[\\/]|^daemon[\\/]src[\\/]handlers[\\/]/;

const FACTORY_NAME_RE = /^(?:make|create)[A-Z].*Handler$/;
const HANDLER_NAME_RE = /^handle[A-Z]/;

const VALIDATOR_NAME_RE = /^(?:Check|validate|assert|parse|plan|check|decide|read|decode)[A-Z]?/;
const VALIDATOR_METHOD_RE = /^(?:check|parse|validate|assert)$/;

const EXEMPT_TAG_RE = /@envelope-check-exempt\b/;

/** True if `node` is a function-like AST node (declaration, expression,
 *  arrow). */
function isFunctionLike(node) {
  return (
    node &&
    (node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression')
  );
}

/** Pull the body's first executable statement, descending through a
 *  single-expression arrow body if needed. Returns null if the body is
 *  empty / not analysable. */
function firstStatement(fn) {
  if (!fn || !fn.body) return null;
  // Arrow with expression body: `(req) => something(req)` — the
  // expression IS the statement.
  if (fn.body.type !== 'BlockStatement') {
    return { type: 'ExpressionStatement', expression: fn.body };
  }
  const stmts = fn.body.body;
  if (!stmts || stmts.length === 0) return null;
  return stmts[0];
}

/** Walk down a CallExpression callee to a string we can match against
 *  the validator regex. Returns null if no recognisable name. */
function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property) {
    if (callee.property.type === 'Identifier') return callee.property.name;
  }
  return null;
}

/** True if the given expression looks like a recognised validator call.
 *  Handles `Check(...)`, `validateFoo(req)`, `obj.check(req)`,
 *  `await Check(...)`, and `const x = Check(...)`. */
function isValidatorCall(expr) {
  if (!expr) return false;
  // `await Check(...)` — unwrap.
  if (expr.type === 'AwaitExpression') return isValidatorCall(expr.argument);
  // `void Check(...)` — unwrap.
  if (expr.type === 'UnaryExpression' && expr.operator === 'void') {
    return isValidatorCall(expr.argument);
  }
  if (expr.type !== 'CallExpression') return false;
  const callee = expr.callee;
  // `something.check(...)` / `.parse(...)` / `.validate(...)` /
  // `.assert(...)` — match by method name regardless of receiver.
  if (callee.type === 'MemberExpression' && callee.property &&
      callee.property.type === 'Identifier' &&
      VALIDATOR_METHOD_RE.test(callee.property.name)) {
    return true;
  }
  // `Check(...)` / `validateFoo(...)` / `assertX(...)` /
  // `parseEnvelope(...)` / `planFoo(...)` — match by callee name.
  const name = calleeName(callee);
  if (!name) return false;
  if (name === 'Check' || name === 'check') return true;
  return VALIDATOR_NAME_RE.test(name);
}

/** Recognise the leading idempotency / state guards that some handlers
 *  legitimately place before the validator (e.g. daemon.shutdown's
 *  replay short-circuit). We accept up to ONE such guard if its body
 *  is purely a `return` of a constant-shaped object — the actual
 *  validator must then appear in the next statement. Conservative on
 *  purpose. */
function isPreValidatorGuard(stmt) {
  if (!stmt || stmt.type !== 'IfStatement') return false;
  const cons = stmt.consequent;
  if (!cons) return false;
  // `if (...) return ...;`
  if (cons.type === 'ReturnStatement') return true;
  // `if (...) { return ...; }` — single-statement block of return.
  if (cons.type === 'BlockStatement' &&
      cons.body.length === 1 &&
      cons.body[0].type === 'ReturnStatement') {
    return true;
  }
  return false;
}

/** Inspect the first 1-2 statements of a handler body for a recognised
 *  validator call. Allows ONE leading idempotency guard (see above)
 *  before requiring the validator. */
function bodyHasCheck(fn) {
  if (!fn || !fn.body || fn.body.type !== 'BlockStatement') {
    // Single-expression arrow: the expression itself must be a
    // validator call (rare — most handlers are `async (req) => { ... }`).
    const first = firstStatement(fn);
    if (!first) return false;
    return isValidatorCall(first.expression);
  }
  const stmts = fn.body.body;
  for (let i = 0; i < Math.min(stmts.length, 3); i++) {
    const stmt = stmts[i];
    // Common shapes:
    //   ExpressionStatement: `Check(Schema, req);`
    //   VariableDeclaration: `const validated = validateFoo(req);`
    //                        `const plan = planX(req, ctx);`
    if (stmt.type === 'ExpressionStatement' && isValidatorCall(stmt.expression)) {
      return true;
    }
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (d.init && isValidatorCall(d.init)) return true;
      }
    }
    if (stmt.type === 'ReturnStatement' && stmt.argument &&
        isValidatorCall(stmt.argument)) {
      // `return planFoo(req, ctx);` — common in factories that delegate
      // straight to a pure decider.
      return true;
    }
    // Allow a single leading idempotency guard, then keep looking.
    if (i === 0 && isPreValidatorGuard(stmt)) continue;
    // Anything else as the first non-guard statement → we will not
    // search further. The spec says "first statement" — we already
    // grant some slack with the guard exception.
    if (i === 0) return false;
    if (i === 1 && !isPreValidatorGuard(stmts[0])) return false;
  }
  return false;
}

/** True if the handler's first parameter is intentionally-unused
 *  (leading underscore — TS/ESLint convention). Indicates the RPC
 *  carries no payload and therefore needs no validator. */
function firstParamIsUnused(fn) {
  if (!fn || !fn.params || fn.params.length === 0) return true;
  const p = fn.params[0];
  // `_req`, `_` — Identifier with leading underscore.
  if (p.type === 'Identifier' && p.name.startsWith('_')) return true;
  // `{ ... }: T = {} as T` — destructured; if there is no first param
  // identifier, conservatively treat as consumed.
  // `_req: unknown = undefined` — AssignmentPattern wrapping Identifier.
  if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier' &&
      p.left.name.startsWith('_')) {
    return true;
  }
  return false;
}

/** True if the source text immediately preceding `node` carries a
 *  `@envelope-check-exempt` JSDoc tag. We walk up to the closest
 *  comment via the ESLint source-code API. */
function hasExemptTag(context, node) {
  const sc = context.sourceCode ?? context.getSourceCode();
  if (!sc) return false;
  const comments = sc.getCommentsBefore?.(node) ?? [];
  for (const c of comments) {
    if (EXEMPT_TAG_RE.test(c.value)) return true;
  }
  // Also accept the tag on the enclosing VariableDeclaration /
  // ExportNamedDeclaration — JSDoc above `export function makeFoo()`.
  let p = node.parent;
  while (p && (p.type === 'VariableDeclarator' ||
               p.type === 'VariableDeclaration' ||
               p.type === 'ExportNamedDeclaration' ||
               p.type === 'ReturnStatement')) {
    const above = sc.getCommentsBefore?.(p) ?? [];
    for (const c of above) {
      if (EXEMPT_TAG_RE.test(c.value)) return true;
    }
    p = p.parent;
  }
  return false;
}

/** Decide whether `fn` should be linted as a handler in the given
 *  context (factory result, dispatcher.register arg, or top-level
 *  `handle*` export). */
function isHandlerCandidate(fn, info) {
  // Direct case: passed to dispatcher.register / registerHandler /
  // registerXHandler as the second argument.
  if (info.kind === 'register-arg') return true;
  // Factory return: `function makeFooHandler(...) { return async (req) => ... }`.
  if (info.kind === 'factory-return') return true;
  // Top-level `handle*` named function/expr.
  if (info.kind === 'handle-named') return true;
  return false;
}

/** Visit-time checker: given a function and metadata about how we
 *  found it, report if the body lacks a check. */
function reportIfMissing(context, fn, info) {
  if (!isHandlerCandidate(fn, info)) return;
  if (firstParamIsUnused(fn)) return;
  if (hasExemptTag(context, fn)) return;
  if (bodyHasCheck(fn)) return;
  context.report({
    node: fn,
    messageId: 'missingCheck',
    data: { kind: info.label },
  });
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Envelope handlers under daemon/src/handlers/ must call a recognised validator (Check / validateFoo / planFoo / .check / etc.) as their first statement (frag-3.4.1 §3.4.1.d).',
      recommended: false,
    },
    schema: [
      {
        type: 'object',
        properties: {
          /** Override path matcher. Tests pass synthetic filenames
           *  outside `daemon/src/handlers/` and need to opt those in. */
          handlerPathRegex: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingCheck:
        'Envelope handler ({{kind}}) does not call a recognised validator (Check / validateFoo / planFoo / .check / .parse) as its first statement. Per frag-3.4.1 §3.4.1.d, handlers MUST validate `req` against a per-method schema before any other logic. If this RPC carries no payload, rename the parameter to `_req` (or add `@envelope-check-exempt: <reason>` JSDoc).',
    },
  },
  create(context) {
    const options = context.options?.[0] ?? {};
    const pathRe = options.handlerPathRegex
      ? new RegExp(options.handlerPathRegex)
      : HANDLER_PATH_RE;

    const filename = (context.filename ?? context.getFilename() ?? '').replace(/\\/g, '/');
    if (!pathRe.test(filename)) return {};
    // Tests under handlers/__tests__/ register fake/synthetic handlers
    // that intentionally skip envelope validation (the test owns the
    // validation contract via assertions). Skip them.
    if (/[\\/]__tests__[\\/]/.test(filename) || /\.test\.[mc]?[jt]sx?$/.test(filename)) {
      return {};
    }

    return {
      // Case A: dispatcher.register('method', fn) /
      //         registerHandler('method', fn) /
      //         someThing.register('method', fn).
      CallExpression(node) {
        const callee = node.callee;
        let isRegister = false;
        if (callee.type === 'Identifier' && /^register[A-Z]?\w*Handler?$/.test(callee.name)) {
          isRegister = true;
        } else if (callee.type === 'MemberExpression' && callee.property &&
                   callee.property.type === 'Identifier' &&
                   callee.property.name === 'register') {
          isRegister = true;
        }
        if (!isRegister) return;
        // Handler is normally arg[1] (after the method name). Some
        // helpers take just the handler — fall back to arg[0].
        const args = node.arguments;
        if (!args || args.length === 0) return;
        let handlerArg = args.length >= 2 ? args[1] : args[0];
        if (!handlerArg) return;
        // Inline arrow / function expression — visit body directly.
        if (isFunctionLike(handlerArg)) {
          reportIfMissing(context, handlerArg, {
            kind: 'register-arg',
            label: 'register() inline',
          });
          return;
        }
        // `dispatcher.register('m', makeFooHandler(...))` — the call
        // returns a handler from a factory; that factory's return is
        // covered by Case B below when the factory is defined.
      },

      // Case B: factory functions named `make*Handler` / `create*Handler`
      // that return an inline arrow / function expression. We lint the
      // RETURNED function (the actual handler).
      FunctionDeclaration(node) {
        if (!node.id || !FACTORY_NAME_RE.test(node.id.name)) {
          // Top-level `handle*` named function — lint directly.
          if (node.id && HANDLER_NAME_RE.test(node.id.name)) {
            reportIfMissing(context, node, {
              kind: 'handle-named',
              label: `handle*: ${node.id.name}`,
            });
          }
          return;
        }
        // Walk body for `return <arrow|fn>` and lint that.
        if (!node.body || node.body.type !== 'BlockStatement') return;
        for (const stmt of node.body.body) {
          if (stmt.type === 'ReturnStatement' && isFunctionLike(stmt.argument)) {
            reportIfMissing(context, stmt.argument, {
              kind: 'factory-return',
              label: `${node.id.name} return`,
            });
          }
        }
      },

      // Case B', exported `const makeFooHandler = (...) => { return async (req) => ... }`.
      VariableDeclarator(node) {
        if (!node.id || node.id.type !== 'Identifier') return;
        if (!FACTORY_NAME_RE.test(node.id.name) &&
            !HANDLER_NAME_RE.test(node.id.name)) return;
        const init = node.init;
        if (!init) return;
        // Direct: `const handleFoo = async (req) => { ... }`.
        if (HANDLER_NAME_RE.test(node.id.name) && isFunctionLike(init)) {
          reportIfMissing(context, init, {
            kind: 'handle-named',
            label: `handle*: ${node.id.name}`,
          });
          return;
        }
        // Factory: `const makeFooHandler = (ctx) => async (req) => { ... }`.
        if (FACTORY_NAME_RE.test(node.id.name) && isFunctionLike(init)) {
          // arrow with expression body returning a function:
          //   (ctx) => async (req) => { ... }
          if (init.body && isFunctionLike(init.body)) {
            reportIfMissing(context, init.body, {
              kind: 'factory-return',
              label: `${node.id.name} return`,
            });
            return;
          }
          // block body — walk for `return <fn>`.
          if (init.body && init.body.type === 'BlockStatement') {
            for (const stmt of init.body.body) {
              if (stmt.type === 'ReturnStatement' && isFunctionLike(stmt.argument)) {
                reportIfMissing(context, stmt.argument, {
                  kind: 'factory-return',
                  label: `${node.id.name} return`,
                });
              }
            }
          }
        }
      },
    };
  },
};
