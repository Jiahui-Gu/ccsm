// no-direct-native-import — custom ESLint rule for ccsm.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//   §3.5.1.1.a:
//     "No call site in `daemon/src/pty/**` or `daemon/src/socket/**`
//      may import `ccsm_native.node` directly."
//
// We extend the spec's intent to all of `daemon/src/**` EXCEPT the
// loader shim itself (`daemon/src/native/**`) — the shim is the one
// allowed seat. Any other file that `import`s or `require`s a
// .node — or specifically a path containing `ccsm_native` — is a
// rule violation.
//
// Single-responsibility: this rule is a pure DECIDER over the AST.
// It produces one `report({ messageId })` per violating node, no
// auto-fix (the fix is a refactor: route through
// `daemon/src/native/index.ts`'s `native()` accessor).

'use strict';

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid direct loads of ccsm_native.node or any .node binary outside daemon/src/native/. Per frag-3.5.1 §3.5.1.1.a, every native call must go through the daemon/src/native/index.ts swap interface.',
      recommended: false,
    },
    schema: [],
    messages: {
      directImport:
        'Direct native-binding load detected ({{spec}}). Per frag-3.5.1 §3.5.1.1.a, route through daemon/src/native/index.ts (`native()` / `loadCcsmNative()`) instead.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // The shim is the only file allowed to load the .node directly.
    // Normalize separators for cross-platform path matching. We accept
    // the substring `daemon/src/native/` with or without a leading
    // slash so unit-test filenames (passed without an absolute prefix)
    // and real filesystem paths both round-trip.
    const norm = filename.replace(/\\/g, '/');
    if (
      norm.includes('/daemon/src/native/') ||
      norm.startsWith('daemon/src/native/')
    ) {
      return {};
    }

    function checkSpec(specNode, raw) {
      if (typeof raw !== 'string') return;
      // Two patterns we care about:
      //   1. anything ending in `.node`           — direct dlopen
      //   2. anything containing `ccsm_native`    — even via require.resolve
      const isDotNode = raw.endsWith('.node');
      const isCcsmNative = raw.includes('ccsm_native');
      if (isDotNode || isCcsmNative) {
        context.report({
          node: specNode,
          messageId: 'directImport',
          data: { spec: raw },
        });
      }
    }

    return {
      ImportDeclaration(node) {
        checkSpec(node.source, node.source.value);
      },
      ImportExpression(node) {
        if (node.source && node.source.type === 'Literal') {
          checkSpec(node.source, node.source.value);
        }
      },
      CallExpression(node) {
        // require('...'), require.resolve('...'), createRequire(...)('...')
        const callee = node.callee;
        const isRequire =
          (callee.type === 'Identifier' && callee.name === 'require') ||
          (callee.type === 'MemberExpression' &&
            callee.object &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'require' &&
            callee.property &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'resolve');
        if (!isRequire) return;
        const arg = node.arguments && node.arguments[0];
        if (arg && arg.type === 'Literal') {
          checkSpec(arg, arg.value);
        }
      },
    };
  },
};
