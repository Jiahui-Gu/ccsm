import { describe, it, expect } from 'vitest';
import {
  diffFromEditInput,
  diffFromWriteInput,
  diffFromMultiEditInput,
  diffFromToolInput
} from '../src/utils/diff';

describe('diff parsers', () => {
  it('Edit: splits old/new strings into lines', () => {
    const d = diffFromEditInput({
      file_path: '/a/b.ts',
      old_string: 'const x = 1;\nconst y = 2;',
      new_string: 'const x = 10;\nconst y = 20;'
    });
    expect(d).not.toBeNull();
    expect(d!.filePath).toBe('/a/b.ts');
    expect(d!.hunks).toHaveLength(1);
    expect(d!.hunks[0].removed).toEqual(['const x = 1;', 'const y = 2;']);
    expect(d!.hunks[0].added).toEqual(['const x = 10;', 'const y = 20;']);
  });

  it('Edit: returns null on missing file_path', () => {
    expect(diffFromEditInput({ old_string: 'a', new_string: 'b' })).toBeNull();
  });

  it('Edit: returns null when both old/new are empty', () => {
    expect(diffFromEditInput({ file_path: '/a', old_string: '', new_string: '' })).toBeNull();
  });

  it('Write: produces a single all-added hunk', () => {
    const d = diffFromWriteInput({ file_path: '/a/c.ts', content: 'line one\nline two' });
    expect(d!.hunks[0].removed).toEqual([]);
    expect(d!.hunks[0].added).toEqual(['line one', 'line two']);
  });

  it('Write: empty content still produces a hunk with empty added', () => {
    const d = diffFromWriteInput({ file_path: '/a/c.ts', content: '' });
    expect(d!.hunks[0].added).toEqual([]);
  });

  it('MultiEdit: one hunk per edit', () => {
    const d = diffFromMultiEditInput({
      file_path: '/a/d.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b\nb2', new_string: 'B\nB2' }
      ]
    });
    expect(d!.hunks).toHaveLength(2);
    expect(d!.hunks[1].removed).toEqual(['b', 'b2']);
    expect(d!.hunks[1].added).toEqual(['B', 'B2']);
  });

  it('MultiEdit: returns null when edits array is empty', () => {
    expect(diffFromMultiEditInput({ file_path: '/a', edits: [] })).toBeNull();
  });

  it('diffFromToolInput dispatches by tool name', () => {
    expect(diffFromToolInput('Edit', { file_path: '/x', old_string: 'a', new_string: 'b' })).not.toBeNull();
    expect(diffFromToolInput('Write', { file_path: '/x', content: 'a' })).not.toBeNull();
    expect(diffFromToolInput('MultiEdit', { file_path: '/x', edits: [{ old_string: 'a', new_string: 'b' }] })).not.toBeNull();
    expect(diffFromToolInput('Bash', { command: 'ls' })).toBeNull();
  });
});
