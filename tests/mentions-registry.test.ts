// Pure-function tests for the @file mention registry. Companion to the
// /-command registry tests in `slash-commands-registry.test.ts`. Picker
// behavior + keyboard plumbing live in `inputbar.test.tsx`.

import { describe, it, expect } from 'vitest';
import {
  detectAtTrigger,
  filterMentionFiles,
  commitMention,
} from '../src/mentions/registry';
import type { WorkspaceFile } from '../src/shared/ipc-types';

describe('detectAtTrigger', () => {
  it('opens the picker after a bare @ at start of input', () => {
    const t = detectAtTrigger('@', 1);
    expect(t.active).toBe(true);
    if (t.active) {
      expect(t.query).toBe('');
      expect(t.atStart).toBe(0);
    }
  });

  it('opens after @ preceded by whitespace', () => {
    const t = detectAtTrigger('hello @src', 'hello @src'.length);
    expect(t.active).toBe(true);
    if (t.active) expect(t.query).toBe('src');
  });

  it('captures only the partial query up to the caret', () => {
    const value = 'hello @sr extra';
    // Caret right after `r` in `sr`.
    const caret = 'hello @sr'.length;
    const t = detectAtTrigger(value, caret);
    expect(t.active).toBe(true);
    if (t.active) expect(t.query).toBe('sr');
  });

  it('does not trigger when @ is part of an email-like token', () => {
    const t = detectAtTrigger('hello@world', 'hello@world'.length);
    expect(t.active).toBe(false);
  });

  it('closes the trigger as soon as whitespace is typed inside the token', () => {
    // Caret is past a space — the picker should close.
    const t = detectAtTrigger('@src foo', '@src foo'.length);
    expect(t.active).toBe(false);
  });

  it('handles caret in the middle of a multi-line composer', () => {
    const value = 'first line\n@sr';
    const t = detectAtTrigger(value, value.length);
    expect(t.active).toBe(true);
    if (t.active) expect(t.query).toBe('sr');
  });
});

describe('filterMentionFiles', () => {
  const files: WorkspaceFile[] = [
    { path: 'src/InputBar.tsx', name: 'InputBar.tsx' },
    { path: 'src/MentionPicker.tsx', name: 'MentionPicker.tsx' },
    { path: 'src/lib/cn.ts', name: 'cn.ts' },
    { path: 'README.md', name: 'README.md' },
  ];

  it('returns all files (capped) for an empty query', () => {
    const r = filterMentionFiles(files, '');
    expect(r).toHaveLength(files.length);
  });

  it('pins exact basename matches first', () => {
    const r = filterMentionFiles(files, 'cn.ts');
    expect(r[0]?.name).toBe('cn.ts');
  });

  it('pins prefix matches before fuzzy matches', () => {
    const r = filterMentionFiles(files, 'Input');
    expect(r[0]?.name).toBe('InputBar.tsx');
  });

  it('falls back to fuzzy match on typos', () => {
    // `mntion` should still surface MentionPicker via Fuse.
    const r = filterMentionFiles(files, 'mntion');
    expect(r.some((f) => f.name === 'MentionPicker.tsx')).toBe(true);
  });
});

describe('commitMention', () => {
  it('replaces the in-progress @-token with @<path> + trailing space', () => {
    const value = 'see @sr';
    const trigger = { atStart: 4, tokenEnd: value.length };
    const { next, caret } = commitMention(value, trigger, 'src/InputBar.tsx');
    expect(next).toBe('see @src/InputBar.tsx ');
    expect(caret).toBe(next.length);
  });

  it('keeps the caret immediately after the inserted mention when text follows', () => {
    const value = '@s rest';
    // tokenEnd points past `@s`, BEFORE the space.
    const trigger = { atStart: 0, tokenEnd: 2 };
    const { next, caret } = commitMention(value, trigger, 'src/foo.ts');
    // The existing space after the original `@s` is preserved (we don't
    // double-up). Caret sits right after `@src/foo.ts`, before the space.
    expect(next).toBe('@src/foo.ts rest');
    expect(caret).toBe('@src/foo.ts'.length);
  });
});
