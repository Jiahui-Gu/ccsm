// Regression: PR #510 (#607) — `fix(import): import targets focused
// group`.
//
// Bug: `ImportDialog#doImport` always wrote new rows into the catch-all
// "Imported" group. A user reading group "research" who hit Import had
// to manually drag every new row out of "Imported" into "research".
//
// Fix: when `store.focusedGroupId` resolves to a normal group, route the
// import there. Without a focus, fall back to the (created-on-demand)
// "Imported" bucket. Also: the focused id is captured in `doImport`'s
// closure, so a batch of N imported rows all land in the focused group
// (the store clears `focusedGroupId` on each `importSession` call but
// the closure already holds the original id).
//
// Existing coverage gap: the PR shipped with only a manual checklist —
// no e2e probe and no unit test. The store slice tests
// (`tests/stores/slices/sessionCrudSlice.test.ts`) exercise
// `importSession` directly but never the dialog wiring that decides the
// `groupId` argument from `focusedGroupId`. This file pins that wiring.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react';
import { ImportDialog } from '../../src/components/ImportDialog';
import { useStore } from '../../src/stores/store';

type Scannable = {
  sessionId: string;
  cwd: string;
  title: string;
  mtime: number;
  projectDir: string;
  model: string | null;
};

const fakeRows: Scannable[] = [
  {
    sessionId: 'imp-1',
    cwd: '/work/proj-a',
    title: 'session-a',
    mtime: Date.now(),
    projectDir: '/home/u/.claude/projects/proj-a',
    model: null,
  },
  {
    sessionId: 'imp-2',
    cwd: '/work/proj-b',
    title: 'session-b',
    mtime: Date.now(),
    projectDir: '/home/u/.claude/projects/proj-b',
    model: null,
  },
];

function installCcsmStub() {
  (window as unknown as { ccsm: unknown }).ccsm = {
    scanImportable: vi.fn().mockResolvedValue(fakeRows),
  } as unknown as Window['ccsm'];
}

function clearCcsmStub() {
  (window as unknown as { ccsm?: unknown }).ccsm = undefined;
}

afterEach(() => {
  cleanup();
  clearCcsmStub();
});

describe('PR #510 regression — ImportDialog targets focused group', () => {
  beforeEach(() => {
    installCcsmStub();
  });

  it('routes imports into focusedGroupId when set to a normal group', async () => {
    const importSession = vi.fn();
    const createGroup = vi.fn().mockReturnValue('g-imported-fallback');
    const renameGroup = vi.fn();
    useStore.setState({
      sessions: [],
      groups: [
        { id: 'g-research', name: 'research', collapsed: false, kind: 'normal' },
        { id: 'g-other', name: 'other', collapsed: false, kind: 'normal' },
      ],
      focusedGroupId: 'g-research',
      importSession,
      createGroup,
      renameGroup,
    });

    render(<ImportDialog open onOpenChange={() => {}} />);
    // Wait for scanImportable to resolve and rows to render.
    await waitFor(() => {
      expect(screen.getByText('session-a')).toBeInTheDocument();
    });
    // Select all then trigger import.
    const selectAll = screen.getByRole('button', { name: /select all/i });
    fireEvent.click(selectAll);
    const importBtn = screen.getByRole('button', { name: /^import \d/i });
    fireEvent.click(importBtn);

    await waitFor(() => expect(importSession).toHaveBeenCalledTimes(2));
    // Both rows must land in g-research, NOT in a created "Imported" bucket.
    for (const call of importSession.mock.calls) {
      expect(call[0].groupId).toBe('g-research');
    }
    // Fallback bucket creation must NOT have fired when a focused group exists.
    expect(createGroup).not.toHaveBeenCalled();
    expect(renameGroup).not.toHaveBeenCalled();
  });

  it('falls back to the "Imported" bucket when focusedGroupId is null', async () => {
    const importSession = vi.fn();
    const createGroup = vi.fn().mockReturnValue('g-new-imported');
    const renameGroup = vi.fn();
    useStore.setState({
      sessions: [],
      groups: [{ id: 'g-default', name: 'Default', collapsed: false, kind: 'normal' }],
      focusedGroupId: null,
      importSession,
      createGroup,
      renameGroup,
    });

    render(<ImportDialog open onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('session-a')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /^import \d/i }));

    await waitFor(() => expect(importSession).toHaveBeenCalledTimes(2));
    // Imported bucket created on demand and used as the target groupId.
    expect(createGroup).toHaveBeenCalledWith('Imported');
    for (const call of importSession.mock.calls) {
      expect(call[0].groupId).toBe('g-new-imported');
    }
  });

  it('reuses an existing "Imported" group when present and unfocused', async () => {
    const importSession = vi.fn();
    const createGroup = vi.fn();
    useStore.setState({
      sessions: [],
      groups: [{ id: 'g-imp-existing', name: 'Imported', collapsed: false, kind: 'normal' }],
      focusedGroupId: null,
      importSession,
      createGroup,
      renameGroup: vi.fn(),
    });

    render(<ImportDialog open onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('session-a')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /^import \d/i }));

    await waitFor(() => expect(importSession).toHaveBeenCalledTimes(2));
    expect(createGroup).not.toHaveBeenCalled();
    for (const call of importSession.mock.calls) {
      expect(call[0].groupId).toBe('g-imp-existing');
    }
  });
});
