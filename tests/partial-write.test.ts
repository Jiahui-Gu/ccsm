import { describe, it, expect } from 'vitest';
import { filterToolInputByAcceptedHunks } from '../electron/agent/partial-write';

describe('filterToolInputByAcceptedHunks (#251)', () => {
  describe('legacy / no selection', () => {
    it('undefined acceptedHunks => unchanged (legacy whole-allow path)', () => {
      const r = filterToolInputByAcceptedHunks('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }, undefined);
      expect(r).toEqual({ kind: 'unchanged' });
    });

    it('non-object input => unchanged (defensive)', () => {
      expect(filterToolInputByAcceptedHunks('Edit', null, [0])).toEqual({ kind: 'unchanged' });
      expect(filterToolInputByAcceptedHunks('Edit', 'string', [0])).toEqual({ kind: 'unchanged' });
      expect(filterToolInputByAcceptedHunks('Edit', [], [0])).toEqual({ kind: 'unchanged' });
    });

    it('unknown tool => unchanged', () => {
      expect(filterToolInputByAcceptedHunks('Bash', { command: 'ls' }, [])).toEqual({ kind: 'unchanged' });
    });
  });

  describe('Edit (single hunk)', () => {
    const editInput = { file_path: '/a', old_string: 'a', new_string: 'b' };
    it('hunk 0 accepted => unchanged (full allow)', () => {
      expect(filterToolInputByAcceptedHunks('Edit', editInput, [0])).toEqual({ kind: 'unchanged' });
    });
    it('empty selection => reject', () => {
      expect(filterToolInputByAcceptedHunks('Edit', editInput, [])).toEqual({ kind: 'reject' });
    });
  });

  describe('Write (single hunk)', () => {
    const writeInput = { file_path: '/a', content: 'hello' };
    it('hunk 0 accepted => unchanged', () => {
      expect(filterToolInputByAcceptedHunks('Write', writeInput, [0])).toEqual({ kind: 'unchanged' });
    });
    it('empty selection => reject (would otherwise write empty file)', () => {
      expect(filterToolInputByAcceptedHunks('Write', writeInput, [])).toEqual({ kind: 'reject' });
    });
  });

  describe('MultiEdit', () => {
    const meInput = {
      file_path: '/a',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B' },
        { old_string: 'c', new_string: 'C' },
      ],
    };

    it('all indices accepted => unchanged', () => {
      expect(filterToolInputByAcceptedHunks('MultiEdit', meInput, [0, 1, 2])).toEqual({ kind: 'unchanged' });
    });

    it('subset accepted => updated input with only those edits, in order', () => {
      const r = filterToolInputByAcceptedHunks('MultiEdit', meInput, [0, 2]);
      expect(r.kind).toBe('updated');
      if (r.kind !== 'updated') return;
      expect(r.updatedInput.file_path).toBe('/a');
      expect(r.updatedInput.edits).toEqual([
        { old_string: 'a', new_string: 'A' },
        { old_string: 'c', new_string: 'C' },
      ]);
    });

    it('subset preserves array ordering even if indices given out of order', () => {
      const r = filterToolInputByAcceptedHunks('MultiEdit', meInput, [2, 0]);
      expect(r.kind).toBe('updated');
      if (r.kind !== 'updated') return;
      expect(r.updatedInput.edits).toEqual([
        { old_string: 'a', new_string: 'A' },
        { old_string: 'c', new_string: 'C' },
      ]);
    });

    it('duplicate indices are deduped', () => {
      const r = filterToolInputByAcceptedHunks('MultiEdit', meInput, [1, 1, 1]);
      expect(r.kind).toBe('updated');
      if (r.kind !== 'updated') return;
      expect(r.updatedInput.edits).toEqual([{ old_string: 'b', new_string: 'B' }]);
    });

    it('empty selection => reject', () => {
      expect(filterToolInputByAcceptedHunks('MultiEdit', meInput, [])).toEqual({ kind: 'reject' });
    });

    it('out-of-range / negative / non-integer indices are dropped', () => {
      const r = filterToolInputByAcceptedHunks('MultiEdit', meInput, [-1, 99, 1.5, 1]);
      expect(r.kind).toBe('updated');
      if (r.kind !== 'updated') return;
      expect(r.updatedInput.edits).toEqual([{ old_string: 'b', new_string: 'B' }]);
    });

    it('all indices invalid => reject', () => {
      expect(filterToolInputByAcceptedHunks('MultiEdit', meInput, [99])).toEqual({ kind: 'reject' });
    });

    it('preserves other keys on the input object', () => {
      const r = filterToolInputByAcceptedHunks(
        'MultiEdit',
        { ...meInput, replace_all: false },
        [0]
      );
      expect(r.kind).toBe('updated');
      if (r.kind !== 'updated') return;
      expect(r.updatedInput.replace_all).toBe(false);
      expect(r.updatedInput.file_path).toBe('/a');
    });

    it('does not mutate the caller-provided edits array', () => {
      const original = JSON.parse(JSON.stringify(meInput));
      filterToolInputByAcceptedHunks('MultiEdit', meInput, [1]);
      expect(meInput).toEqual(original);
    });

    it('empty edits array => unchanged (nothing to filter)', () => {
      expect(
        filterToolInputByAcceptedHunks('MultiEdit', { file_path: '/a', edits: [] }, [0])
      ).toEqual({ kind: 'unchanged' });
    });
  });
});
