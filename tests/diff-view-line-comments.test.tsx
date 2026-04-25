// Per-line diff comment affordance (#303).
//
// Three layers under test:
//   1. Store: addDiffComment / updateDiffComment / deleteDiffComment /
//      clearDiffComments behave as documented (delete on empty body, etc.).
//   2. Serialization: serializeDiffCommentsForPrompt produces the exact
//      `<diff-feedback ...>` block format the InputBar will prepend, in a
//      stable order across renders.
//   3. Render: DiffView shows a "+" affordance per line, opens an inline
//      composer on click, saves the comment, and surfaces a chip; the chip
//      is removable + editable.
//
// What we deliberately do NOT exercise here:
//   - InputBar.send wiring is covered by the dedicated `inputbar-diff-comments`
//     integration test (stubs window.ccsm and asserts the prepended payload
//     hits agentSend). Splitting keeps each test honest about its scope.
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import { DiffView } from '../src/components/chat/DiffView';
import type { DiffSpec } from '../src/utils/diff';
import {
  useStore,
  serializeDiffCommentsForPrompt,
  type PendingDiffComment,
} from '../src/stores/store';

const SID = 'sess-303';

beforeEach(() => {
  // Clear diff comments + ensure the active session id matches the bucket we
  // probe. We do NOT reset the rest of the store — other slices are immaterial
  // to this surface and we want to mirror the "comments live alongside real
  // session state" production shape.
  act(() => {
    useStore.setState({ activeId: SID, pendingDiffComments: {} });
  });
});

function spec(file: string, removed: string[], added: string[]): DiffSpec {
  return { filePath: file, hunks: [{ removed, added }] };
}

// Helper: pick the gutter "+" affordance for the Nth diff line (0-indexed)
// in the rendered DiffView. Each line carries `data-diff-line=""` and the
// affordance carries `data-diff-add-comment=""`.
function addCommentButtonForLine(n: number): HTMLButtonElement {
  const lines = document.querySelectorAll('[data-diff-line]');
  const row = lines[n] as HTMLElement | undefined;
  if (!row) throw new Error(`no diff line at index ${n}`);
  const btn = row.querySelector('[data-diff-add-comment]');
  if (!btn) throw new Error(`no add-comment button at line ${n}`);
  return btn as HTMLButtonElement;
}

describe('store: diff comment slice', () => {
  it('addDiffComment trims, assigns an id, and stores under the session bucket', () => {
    const id = useStore.getState().addDiffComment(SID, {
      file: '/a/x.ts',
      line: 2,
      text: '   use X instead of Y   ',
    });
    expect(id).toMatch(/^dfc-/);
    const bucket = useStore.getState().pendingDiffComments[SID];
    expect(bucket).toBeDefined();
    expect(Object.keys(bucket!)).toHaveLength(1);
    const c = bucket![id];
    expect(c.file).toBe('/a/x.ts');
    expect(c.line).toBe(2);
    expect(c.text).toBe('use X instead of Y');
    expect(typeof c.createdAt).toBe('number');
  });

  it('addDiffComment rejects empty / whitespace text and returns ""', () => {
    const id = useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 0, text: '   ' });
    expect(id).toBe('');
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
  });

  it('updateDiffComment with empty text deletes the comment (matches trash semantics)', () => {
    const id = useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 0, text: 'first' });
    useStore.getState().updateDiffComment(SID, id, '   ');
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
  });

  it('deleteDiffComment removes only the targeted comment, removes empty bucket', () => {
    const id1 = useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 0, text: 'one' });
    const id2 = useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 1, text: 'two' });
    useStore.getState().deleteDiffComment(SID, id1);
    const bucket = useStore.getState().pendingDiffComments[SID];
    expect(bucket).toBeDefined();
    expect(Object.keys(bucket!)).toEqual([id2]);
    useStore.getState().deleteDiffComment(SID, id2);
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
  });

  it('clearDiffComments wipes the whole session bucket but leaves siblings', () => {
    useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 0, text: 'mine' });
    useStore.getState().addDiffComment('other-sess', { file: '/b.ts', line: 0, text: 'theirs' });
    useStore.getState().clearDiffComments(SID);
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
    expect(useStore.getState().pendingDiffComments['other-sess']).toBeDefined();
  });
});

describe('serializeDiffCommentsForPrompt', () => {
  function mk(file: string, line: number, text: string, createdAt: number, id = `c-${line}`): PendingDiffComment {
    return { id, file, line, text, createdAt };
  }

  it('returns "" for empty / undefined input so callers can append unconditionally', () => {
    expect(serializeDiffCommentsForPrompt(undefined)).toBe('');
    expect(serializeDiffCommentsForPrompt({})).toBe('');
  });

  it('emits one <diff-feedback> per comment, joined by single newlines', () => {
    const out = serializeDiffCommentsForPrompt({
      a: mk('/x.ts', 1, 'rename foo', 100),
      b: mk('/x.ts', 2, 'use const', 200),
    });
    expect(out).toBe(
      '<diff-feedback file="/x.ts" line="1">rename foo</diff-feedback>\n' +
      '<diff-feedback file="/x.ts" line="2">use const</diff-feedback>'
    );
  });

  it('orders by (file, line, createdAt) regardless of insertion order', () => {
    const out = serializeDiffCommentsForPrompt({
      // Inserted out of order on purpose to prove the sort.
      late: mk('/z.ts', 0, 'last', 999),
      mid: mk('/m.ts', 5, 'mid-5', 100),
      early: mk('/m.ts', 1, 'mid-1', 100),
      tie: mk('/m.ts', 1, 'mid-1-newer', 200),
    });
    const lines = out.split('\n');
    expect(lines[0]).toContain('file="/m.ts" line="1">mid-1<');
    expect(lines[1]).toContain('file="/m.ts" line="1">mid-1-newer<');
    expect(lines[2]).toContain('file="/m.ts" line="5">mid-5<');
    expect(lines[3]).toContain('file="/z.ts" line="0">last<');
  });

  it('escapes embedded double quotes in the file attribute so the tag stays parsable', () => {
    const out = serializeDiffCommentsForPrompt({
      a: mk('/quirky"name.ts', 0, 'text', 100),
    });
    expect(out).toBe('<diff-feedback file="/quirky&quot;name.ts" line="0">text</diff-feedback>');
  });
});

describe('<DiffView /> per-line comment affordance', () => {
  it('renders an "Add a comment" button per diff line', () => {
    render(<DiffView diff={spec('/a/x.ts', ['old'], ['new1', 'new2'])} />);
    // 1 removed + 2 added = 3 diff lines, so 3 add-comment buttons.
    const buttons = document.querySelectorAll('[data-diff-add-comment]');
    expect(buttons).toHaveLength(3);
    // Each button has the localized aria-label so screen readers can find it.
    for (const b of Array.from(buttons)) {
      expect(b.getAttribute('aria-label')).toMatch(/add a comment/i);
    }
  });

  it('clicking the gutter "+" opens the composer; Save persists into the store', async () => {
    render(<DiffView diff={spec('/a/y.ts', [], ['HELLO'])} />);
    fireEvent.click(addCommentButtonForLine(0));
    // Composer textarea should appear with the localized placeholder.
    const composer = document.querySelector('[data-diff-comment-composer]');
    expect(composer).not.toBeNull();
    const ta = within(composer as HTMLElement).getByPlaceholderText(/add a comment for the agent/i);
    fireEvent.change(ta, { target: { value: 'rename HELLO to HI' } });
    // Click the localized Save button (rendered next to "Cancel").
    const saveBtn = within(composer as HTMLElement).getByRole('button', { name: /^save$/i });
    fireEvent.click(saveBtn);
    // The composer has begun its AnimatePresence exit animation — under
    // jsdom the wrapper may still be in the DOM for a tick. The contract
    // we actually care about is "the comment is in the store now", which
    // is observable immediately via the synchronous setState.
    const bucket = useStore.getState().pendingDiffComments[SID];
    expect(bucket).toBeDefined();
    const list = Object.values(bucket!);
    expect(list).toHaveLength(1);
    expect(list[0].file).toBe('/a/y.ts');
    expect(list[0].text).toBe('rename HELLO to HI');
  });

  it('lines with a saved comment expose a chip that re-opens the composer in edit mode', () => {
    // Seed a comment for the only diff line ("ALPHA" at lineIndex=0).
    act(() => {
      useStore.getState().addDiffComment(SID, {
        file: '/a/z.ts',
        line: 0,
        text: 'use BETA',
      });
    });
    render(<DiffView diff={spec('/a/z.ts', [], ['ALPHA'])} />);
    const chip = document.querySelector('[data-diff-comment-chip]');
    expect(chip).not.toBeNull();
    expect((chip as HTMLElement).textContent).toContain('use BETA');
    // Click the chip → composer opens preloaded with the existing text.
    fireEvent.click(chip as HTMLElement);
    const composer = document.querySelector('[data-diff-comment-composer]');
    expect(composer).not.toBeNull();
    const ta = within(composer as HTMLElement).getByDisplayValue('use BETA');
    expect(ta).toBeInTheDocument();
    // Saving with empty body deletes (per updateDiffComment doc).
    fireEvent.change(ta, { target: { value: '   ' } });
    // Save button should be disabled when trimmed text is empty — instead the
    // dedicated Trash button on the composer (data-diff-comment-delete) is
    // the contract for explicit removal.
    const trash = document.querySelector('[data-diff-comment-delete]');
    expect(trash).not.toBeNull();
    fireEvent.click(trash as HTMLElement);
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
  });

  it('Esc inside the composer cancels without saving', () => {
    render(<DiffView diff={spec('/a/k.ts', [], ['LINE'])} />);
    fireEvent.click(addCommentButtonForLine(0));
    const composer = document.querySelector('[data-diff-comment-composer]') as HTMLElement;
    const ta = within(composer).getByPlaceholderText(/add a comment/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'half-typed' } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    // Same caveat as the Save test: framer-motion exit animation may still
    // hold the composer wrapper in the DOM under jsdom. The actual contract
    // is "no comment was persisted", which is observable on the store.
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
  });

  it('Enter on an empty composer cancels (no junk comment) and closes it (#340)', async () => {
    render(<DiffView diff={spec('/a/e.ts', [], ['LINE'])} />);
    fireEvent.click(addCommentButtonForLine(0));
    const composer = document.querySelector('[data-diff-comment-composer]') as HTMLElement;
    expect(composer).not.toBeNull();
    const ta = within(composer).getByPlaceholderText(/add a comment/i) as HTMLTextAreaElement;
    // Whitespace-only counts as empty.
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    // No comment persisted (addDiffComment / updateDiffComment never fired).
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
    // Composer is dismissed. This is the load-bearing assertion for #340 —
    // before the fix, empty Enter was a silent no-op that left the composer
    // hanging open. AnimatePresence exit may take a tick under jsdom, so
    // waitFor handles the brief window before the wrapper unmounts.
    await waitFor(() => {
      expect(document.querySelector('[data-diff-comment-composer]')).toBeNull();
    });
  });

  it('Enter on a non-empty composer still saves (regression guard for #340)', () => {
    render(<DiffView diff={spec('/a/n.ts', [], ['LINE'])} />);
    fireEvent.click(addCommentButtonForLine(0));
    const composer = document.querySelector('[data-diff-comment-composer]') as HTMLElement;
    const ta = within(composer).getByPlaceholderText(/add a comment/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'real feedback' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    const bucket = useStore.getState().pendingDiffComments[SID];
    expect(bucket).toBeDefined();
    const list = Object.values(bucket!);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('real feedback');
  });
});
