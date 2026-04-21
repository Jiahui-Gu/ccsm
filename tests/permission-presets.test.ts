import { describe, it, expect } from 'vitest';
import {
  PERMISSION_PRESETS,
  TOOL_CATALOG,
  deriveToolState,
  getPreset,
  mergeRules,
  parsePatternLines,
  renderEffectiveFlags,
  serializePatternLines,
  setToolState,
  validatePatterns
} from '../src/agent/permission-presets';
import { EMPTY_PERMISSION_RULES } from '../src/types';

describe('PERMISSION_PRESETS', () => {
  it('includes the four expected presets in order', () => {
    expect(PERMISSION_PRESETS.map((p) => p.id)).toEqual([
      'readonly',
      'commonDev',
      'everythingExceptBash',
      'custom'
    ]);
  });

  it('readonly preset only whitelists inspection tools', () => {
    const p = getPreset('readonly');
    expect(p.rules.allowedTools).toContain('Read');
    expect(p.rules.allowedTools).toContain('Glob');
    expect(p.rules.allowedTools).toContain('Grep');
    expect(p.rules.allowedTools).not.toContain('Write');
    expect(p.rules.allowedTools).not.toContain('Bash');
    expect(p.rules.disallowedTools).toContain('Bash');
    expect(p.rules.disallowedTools).toContain('Write');
  });

  it('commonDev preset allows reads/writes and a bash whitelist via scoped patterns', () => {
    const p = getPreset('commonDev');
    expect(p.rules.allowedTools).toContain('Read');
    expect(p.rules.allowedTools).toContain('Write');
    expect(p.rules.allowedTools).toContain('Bash(git:*)');
    expect(p.rules.allowedTools).toContain('Bash(npm:*)');
    // Bare `Bash` NOT whitelisted — otherwise the scoped patterns would be moot.
    expect(p.rules.allowedTools).not.toContain('Bash');
  });

  it('everythingExceptBash denies Bash + KillShell, allows everything else', () => {
    const p = getPreset('everythingExceptBash');
    expect(p.rules.disallowedTools).toContain('Bash');
    expect(p.rules.disallowedTools).toContain('KillShell');
    expect(p.rules.allowedTools).toContain('Write');
    expect(p.rules.allowedTools).toContain('Edit');
  });

  it('custom preset is empty (user-driven edit surface)', () => {
    const p = getPreset('custom');
    expect(p.rules).toEqual(EMPTY_PERMISSION_RULES);
  });
});

describe('TOOL_CATALOG', () => {
  it('covers the standard claude.exe built-in tools', () => {
    for (const t of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'WebFetch', 'Task']) {
      expect(TOOL_CATALOG).toContain(t);
    }
  });
});

describe('deriveToolState', () => {
  it('returns "ask" when the tool appears in neither list', () => {
    expect(deriveToolState(EMPTY_PERMISSION_RULES, 'Bash')).toBe('ask');
  });
  it('returns "allow" for bare-name match', () => {
    const rules = { allowedTools: ['Read'], disallowedTools: [] };
    expect(deriveToolState(rules, 'Read')).toBe('allow');
  });
  it('returns "allow" for any scoped match', () => {
    const rules = { allowedTools: ['Bash(git:*)'], disallowedTools: [] };
    expect(deriveToolState(rules, 'Bash')).toBe('allow');
  });
  it('returns "deny" and deny wins over allow on conflict', () => {
    const rules = { allowedTools: ['Bash'], disallowedTools: ['Bash'] };
    expect(deriveToolState(rules, 'Bash')).toBe('deny');
  });
});

describe('setToolState', () => {
  it('Allow strips any scoped variants for the tool and adds a bare entry', () => {
    const rules = { allowedTools: ['Bash(git:*)'], disallowedTools: [] };
    const next = setToolState(rules, 'Bash', 'allow');
    expect(next.allowedTools).toEqual(['Bash']);
  });
  it('Deny strips both lists for the tool before denying', () => {
    const rules = { allowedTools: ['Bash(git:*)'], disallowedTools: [] };
    const next = setToolState(rules, 'Bash', 'deny');
    expect(next.allowedTools).toEqual([]);
    expect(next.disallowedTools).toEqual(['Bash']);
  });
  it('Ask removes all mentions of the tool from both lists', () => {
    const rules = { allowedTools: ['Read', 'Read(**/*.md)'], disallowedTools: ['Read'] };
    const next = setToolState(rules, 'Read', 'ask');
    expect(next.allowedTools).toEqual([]);
    expect(next.disallowedTools).toEqual([]);
  });
});

describe('mergeRules', () => {
  it('returns a copy of global when session is undefined', () => {
    const global = { allowedTools: ['Read'], disallowedTools: [] };
    const merged = mergeRules(global, undefined);
    expect(merged).toEqual(global);
    expect(merged).not.toBe(global);
  });
  it('concatenates and dedupes across lists', () => {
    const global = { allowedTools: ['Read'], disallowedTools: [] };
    const session = { allowedTools: ['Read', 'Glob'], disallowedTools: [] };
    const merged = mergeRules(global, session);
    expect(merged.allowedTools).toEqual(['Read', 'Glob']);
  });
  it('session deny removes allow entries for the same tool (deny wins)', () => {
    const global = { allowedTools: ['Bash', 'Bash(git:*)'], disallowedTools: [] };
    const session = { allowedTools: [], disallowedTools: ['Bash'] };
    const merged = mergeRules(global, session);
    // Bare `Bash` + any `Bash(...)` entries are stripped from allowed.
    expect(merged.allowedTools).toEqual([]);
    expect(merged.disallowedTools).toEqual(['Bash']);
  });
});

describe('validatePatterns', () => {
  it('accepts well-formed patterns', () => {
    expect(validatePatterns(['Read', 'Bash(git:*)', 'Read(**/*.md)']).ok).toBe(true);
  });
  it('flags unbalanced parens', () => {
    const v = validatePatterns(['Bash(git:*']);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/Unbalanced parens/);
  });
  it('flags missing tool name before parens', () => {
    const v = validatePatterns(['(foo)']);
    expect(v.ok).toBe(false);
  });
  it('flags whitespace in bare tool name', () => {
    const v = validatePatterns(['Bash Read']);
    expect(v.ok).toBe(false);
  });
  it('tolerates empty lines (UI trims before saving)', () => {
    expect(validatePatterns(['  ', '', 'Read']).ok).toBe(true);
  });
});

describe('parsePatternLines / serializePatternLines round-trip', () => {
  it('trims, drops empties, dedupes', () => {
    const parsed = parsePatternLines(' Read \n\n  Bash(git:*)\nRead\n');
    expect(parsed).toEqual(['Read', 'Bash(git:*)']);
  });
  it('serializes back to newline-joined form', () => {
    expect(serializePatternLines(['a', 'b'])).toBe('a\nb');
  });
});

describe('renderEffectiveFlags', () => {
  it('renders just --permission-mode when both arrays are empty', () => {
    expect(renderEffectiveFlags('default', EMPTY_PERMISSION_RULES)).toBe(
      '--permission-mode default'
    );
  });
  it('appends --allowedTools when non-empty', () => {
    const flags = renderEffectiveFlags('default', {
      allowedTools: ['Read', 'Glob'],
      disallowedTools: []
    });
    expect(flags).toContain('--allowedTools "Read Glob"');
  });
  it('appends both flags when both are non-empty', () => {
    const flags = renderEffectiveFlags('plan', {
      allowedTools: ['Read'],
      disallowedTools: ['Bash']
    });
    expect(flags).toBe(
      '--permission-mode plan --allowedTools "Read" --disallowedTools "Bash"'
    );
  });
});
