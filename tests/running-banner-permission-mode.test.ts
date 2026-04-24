// task #320 — verify the running banner copy reflects the active
// permission mode. We assert against substrings of the en catalog so the
// test stays robust to copy tweaks (it confirms the *concept* surfaces in
// the right key, not the exact wording).
import { describe, it, expect } from 'vitest';
import en from '../src/i18n/locales/en';
import zh from '../src/i18n/locales/zh';
import { runningPlaceholderForMode } from '../src/lib/runningPlaceholder';
import type { PermissionMode } from '../src/stores/store';

// Tiny fake `t` that resolves dotted keys against a catalog object.
function makeT(catalog: Record<string, unknown>) {
  return (key: string) => {
    const parts = key.split('.');
    let node: unknown = catalog;
    for (const p of parts) {
      if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        throw new Error(`missing i18n key: ${key}`);
      }
    }
    if (typeof node !== 'string') throw new Error(`not a leaf: ${key}`);
    return node;
  };
}

describe('runningPlaceholderForMode (task #320)', () => {
  const tEn = makeT(en);
  const tZh = makeT(zh);

  const cases: Array<{
    mode: PermissionMode;
    enKey: string;
    enMatch: RegExp;
    zhMatch: RegExp;
  }> = [
    {
      mode: 'default',
      enKey: 'chat.runningPlaceholderDefault',
      enMatch: /will ask for permission/i,
      zhMatch: /询问权限/
    },
    {
      mode: 'acceptEdits',
      enKey: 'chat.runningPlaceholderAcceptEdits',
      enMatch: /auto-accepting edits/i,
      zhMatch: /自动接受编辑/
    },
    {
      mode: 'bypassPermissions',
      enKey: 'chat.runningPlaceholderBypass',
      enMatch: /bypassing permission prompts/i,
      zhMatch: /跳过.*权限/
    },
    {
      mode: 'plan',
      enKey: 'chat.runningPlaceholderPlan',
      enMatch: /planning only/i,
      zhMatch: /仅规划/
    }
  ];

  for (const c of cases) {
    it(`${c.mode} → en copy reflects mode and shares Esc/Enter affordance`, () => {
      const got = runningPlaceholderForMode(tEn, c.mode);
      expect(got).toMatch(c.enMatch);
      // Affordance hint is preserved across all variants so muscle memory
      // from the original `runningPlaceholder` survives.
      expect(got).toMatch(/Esc to interrupt/);
      expect(got).toMatch(/Enter to queue/);
      // Sentence case — the leading word is "Running" not "RUNNING".
      expect(got.startsWith('Running')).toBe(true);
      expect(got).not.toMatch(/RUNNING/);
    });

    it(`${c.mode} → zh copy reflects mode and shares Esc/Enter affordance`, () => {
      const got = runningPlaceholderForMode(tZh, c.mode);
      expect(got).toMatch(c.zhMatch);
      expect(got).toMatch(/Esc 中断/);
      expect(got).toMatch(/Enter 排队/);
    });
  }

  it('unknown mode falls back to the default-mode copy (conservative)', () => {
    const got = runningPlaceholderForMode(tEn, 'someFutureMode' as PermissionMode);
    expect(got).toBe(tEn('chat.runningPlaceholderDefault'));
  });
});
