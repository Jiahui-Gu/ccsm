// Reverse-verify the local ESLint rule from Task #132 (frag-11 §11.6).
// Three valid + three invalid fixtures cover the rule's contract:
//   invalid: bare 'CCSM' segment, '/CCSM/' embedded, 'CCSM/foo' prefix.
//   valid  : 'ccsm' lowercase, env var name 'CCSM_DAEMON_SECRET',
//            macOS bundle 'CCSM.app'.

import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
const rule = localRequire('../../eslint-rules/no-uppercase-ccsm-path.js');

function lintSource(src: string): string[] {
  const linter = new Linter();
  const messages = linter.verify(
    src,
    {
      plugins: { 'ccsm-local': { rules: { 'no-uppercase-ccsm-path': rule } } },
      rules: { 'ccsm-local/no-uppercase-ccsm-path': 'error' },
    },
    'snippet.js',
  );
  return messages.map((m) => m.messageId ?? m.message);
}

describe("eslint-rules/no-uppercase-ccsm-path", () => {
  describe('invalid (must report)', () => {
    it("flags a bare 'CCSM' path-join segment", () => {
      const out = lintSource("path.join(root, 'CCSM', 'data');");
      expect(out).toContain('uppercaseCcsm');
    });
    it("flags an embedded '/CCSM/' segment in a hard-coded path", () => {
      const out = lintSource("const p = '/home/u/.local/share/CCSM/crashes';");
      expect(out).toContain('uppercaseCcsm');
    });
    it("flags a 'CCSM/foo' prefix in a relative path literal", () => {
      const out = lintSource("const p = 'CCSM/data/ccsm.db';");
      expect(out).toContain('uppercaseCcsm');
    });
  });

  describe('valid (must NOT report)', () => {
    it("allows a lowercase 'ccsm' path segment", () => {
      const out = lintSource("path.join(root, 'ccsm', 'data');");
      expect(out).not.toContain('uppercaseCcsm');
    });
    it("allows the env var name 'CCSM_DAEMON_SECRET'", () => {
      const out = lintSource("const k = 'CCSM_DAEMON_SECRET';");
      expect(out).not.toContain('uppercaseCcsm');
    });
    it("allows the macOS bundle name 'CCSM.app'", () => {
      const out = lintSource("path.join(out, 'CCSM.app', 'Contents');");
      expect(out).not.toContain('uppercaseCcsm');
    });
  });
});
