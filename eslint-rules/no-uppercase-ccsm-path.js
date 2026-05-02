// eslint-rules/no-uppercase-ccsm-path.js
//
// Task #132 (frag-11 §11.6): Linux is case-sensitive. The v0.3 dataRoot
// MUST use the lowercase `ccsm` segment everywhere — Windows installers
// (NSIS) emit `%LOCALAPPDATA%\ccsm`, the daemon resolver returns
// `~/.local/share/ccsm`, the macOS resolver returns
// `~/Library/Application Support/ccsm`. A single `path.join(..., 'CCSM',
// ...)` regression on the Electron side puts the daemon.lock in a different
// directory on Linux than the installer cleanup expects → uninstall leaks +
// fresh installs find no daemon.lock and start a second daemon.
//
// This rule scans string literals + template literal quasis for the
// substring `CCSM` when it would actually appear in a path:
//   - Hard fail: `'CCSM'` as a standalone segment (likely `path.join` arg).
//   - Hard fail: a literal containing `/CCSM/`, `\CCSM\`, `/CCSM` at end,
//     `CCSM/` at start (path-shaped).
//   - Hard fail: `CCSM.app` / `CCSM.exe` are EXEMPT — those are the macOS
//     bundle / Windows binary names derived from `productName`, not
//     dataRoot path segments.
//
// Allowed (NOT flagged):
//   - `CCSM_*` env-var names (e.g. `CCSM_DAEMON_SECRET`, `CCSM_DATA_ROOT`).
//   - import/require paths (`from '...'`, `require('...')`).
//   - Comments (the rule only inspects literals).
//   - UI strings + log messages where `CCSM` is the brand label.
//   - The macOS bundle name `CCSM.app` and Windows binary `CCSM.exe` /
//     `CCSM Dev.exe`.
//
// Reverse-verified by tests/eslint-rules/no-uppercase-ccsm-path.test.js.

'use strict';

const PATH_FN_NAMES = new Set(['join', 'resolve', 'normalize']);

/** Does the parent CallExpression look like `path.<fn>(...)` / `posix.<fn>(...)` / `win32.<fn>(...)`? */
function isPathJoinCall(parent) {
  if (!parent || parent.type !== 'CallExpression') return false;
  const callee = parent.callee;
  if (!callee || callee.type !== 'MemberExpression') return false;
  const prop = callee.property;
  if (!prop || prop.type !== 'Identifier' || !PATH_FN_NAMES.has(prop.name)) return false;
  const obj = callee.object;
  // path.join / posix.join / win32.join / path.posix.join — match the head ident.
  if (obj.type === 'Identifier' && /^(path|posix|win32)$/.test(obj.name)) return true;
  if (obj.type === 'MemberExpression' && obj.property?.type === 'Identifier' &&
      /^(posix|win32)$/.test(obj.property.name)) return true;
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow uppercase CCSM in path-shaped string literals (frag-11 §11.6 / Task #132).',
    },
    schema: [],
    messages: {
      uppercaseCcsm:
        'Path-shaped literal contains uppercase "CCSM"; use lowercase "ccsm" per frag-11 §11.6 (Linux is case-sensitive). If this is a brand label or env var name, refactor to make that obvious (e.g. extract to a constant).',
    },
  },
  create(context) {
    /** Returns true iff `value` looks like an embedded path with an uppercase CCSM segment. */
    function isOffendingEmbeddedPath(value) {
      if (typeof value !== 'string') return false;
      if (!value.includes('CCSM')) return false;

      // Exempt: env-var name shape (CCSM_FOO, all caps + underscore).
      if (/^CCSM(_[A-Z0-9]+)+$/.test(value)) return false;

      // Strip macOS bundle / Windows binary names — those come from
      // `productName: "CCSM"` and are NOT dataRoot path segments.
      const stripped = value
        .replace(/CCSM\.app/g, '')
        .replace(/CCSM Dev\.exe/g, '')
        .replace(/CCSM\.exe/g, '');
      if (!stripped.includes('CCSM')) return false;

      // Path-shaped triggers: separator before/after `CCSM`.
      if (/[\\/]CCSM(?:[\\/]|$)/.test(stripped)) return true;
      if (/^CCSM[\\/]/.test(stripped)) return true;
      return false;
    }

    /** Bare `'CCSM'` literals are only flagged when used as a path.join-style arg. */
    function isOffendingBareCcsm(value, node) {
      if (value !== 'CCSM') return false;
      return isPathJoinCall(node.parent);
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (isOffendingEmbeddedPath(node.value) || isOffendingBareCcsm(node.value, node)) {
          context.report({ node, messageId: 'uppercaseCcsm' });
        }
      },
      TemplateElement(node) {
        const raw = node.value && node.value.cooked;
        if (isOffendingEmbeddedPath(raw)) {
          context.report({ node, messageId: 'uppercaseCcsm' });
        }
      },
    };
  },
};
