// UT for src/components/ImportDialog.tsx — covers the multi-step picker UI
// that wraps electron/import-scanner.ts output. Mocks the store and
// `window.ccsm.scanImportable` so the file exercises pure dialog state +
// the importSession action contract.
//
// Coverage targets the import-flow data contract:
//   1. Loading state while scan promise is pending
//   2. Empty / error scanner result → empty-state copy
//   3. Toggling rows, toggling whole buckets, select-all / deselect-all
//   4. Bucket collapse / expand
//   5. Selecting a row → enables the primary button + updates the count
//   6. Submit → fans out one importSession() call per picked row, passing
//      cwd / title / projectDir / resumeSessionId verbatim
//   7. Submit → routes into focused group when one is selected
//   8. Submit → creates the "Imported" group when none focused + bucket missing
//   9. Submit → closes the dialog via onOpenChange(false)
//  10. Already-known sessions are filtered out before display
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { ImportDialog } from '../../src/components/ImportDialog';

// ---- Store mock -----------------------------------------------------------
// ImportDialog reads via `useStore((s) => s.field)` — we mock the hook to
// pull from a shared mutable state container so each test can preset
// fixtures (sessions, groups, focusedGroupId) and then introspect the
// action calls the component fires.

type ScannableRow = {
  sessionId: string;
  cwd: string;
  title: string;
  mtime: number;
  projectDir: string;
  model: string | null;
};

type StoreShape = {
  sessions: Array<{ id: string }>;
  groups: Array<{ id: string; name: string; kind: 'normal' | 'archive' }>;
  focusedGroupId: string | null;
  importSession: ReturnType<typeof vi.fn>;
  createGroup: ReturnType<typeof vi.fn>;
  renameGroup: ReturnType<typeof vi.fn>;
};

const storeState: StoreShape = {
  sessions: [],
  groups: [],
  focusedGroupId: null,
  importSession: vi.fn(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
};

vi.mock('../../src/stores/store', () => ({
  useStore: <T,>(selector: (s: StoreShape) => T): T => selector(storeState),
}));

// ---- Bridge mock ----------------------------------------------------------
function installBridge(scan: () => Promise<ScannableRow[]>) {
  const api = { scanImportable: vi.fn(scan) };
  (window as unknown as { ccsm: unknown }).ccsm = api;
  return api;
}

function deferredScan(): { promise: Promise<ScannableRow[]>; resolve: (r: ScannableRow[]) => void; reject: (e: unknown) => void } {
  let resolve!: (r: ScannableRow[]) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<ScannableRow[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function row(over: Partial<ScannableRow> = {}): ScannableRow {
  return {
    sessionId: over.sessionId ?? 'sid-' + Math.random().toString(36).slice(2, 8),
    cwd: over.cwd ?? '/Users/foo/proj',
    title: over.title ?? 'Some title',
    mtime: over.mtime ?? Date.now(),
    projectDir: over.projectDir ?? '-Users-foo-proj',
    model: over.model ?? null,
  };
}

beforeEach(() => {
  storeState.sessions = [];
  storeState.groups = [];
  storeState.focusedGroupId = null;
  storeState.importSession = vi.fn();
  storeState.createGroup = vi.fn(() => 'g-created');
  storeState.renameGroup = vi.fn();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ccsm?: unknown }).ccsm;
});

// ---- Helpers --------------------------------------------------------------
async function renderOpen(rows: ScannableRow[]) {
  installBridge(() => Promise.resolve(rows));
  const onOpenChange = vi.fn();
  await act(async () => {
    render(<ImportDialog open onOpenChange={onOpenChange} />);
    // Flush the scan promise.
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onOpenChange };
}

describe('<ImportDialog />', () => {
  it('shows the loading copy while the scan promise is pending', async () => {
    const d = deferredScan();
    installBridge(() => d.promise);
    render(<ImportDialog open onOpenChange={vi.fn()} />);
    // Synchronous: useEffect kicks off the scan, loading=true is set
    // before the promise resolves. The mocked-i18n 'en' bundle uses
    // 'Scanning…' for this key.
    expect(screen.getByText(/Scanning/i)).toBeInTheDocument();

    await act(async () => {
      d.resolve([]);
      await Promise.resolve();
    });
  });

  it('shows the empty-state copy when the scanner returns no rows', async () => {
    await renderOpen([]);
    expect(screen.getByText(/No importable transcripts/i)).toBeInTheDocument();
    expect(screen.getByText('~/.claude/projects/')).toBeInTheDocument();
  });

  it('shows the empty-state copy when the scanner promise rejects', async () => {
    installBridge(() => Promise.reject(new Error('boom')));
    await act(async () => {
      render(<ImportDialog open onOpenChange={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/No importable transcripts/i)).toBeInTheDocument();
  });

  it('renders one row per scanned session with cwd and title visible', async () => {
    await renderOpen([
      row({ sessionId: 's1', title: 'First', cwd: '/work/a' }),
      row({ sessionId: 's2', title: 'Second', cwd: '/work/b' }),
    ]);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText(/\/work\/a/)).toBeInTheDocument();
    expect(screen.getByText(/\/work\/b/)).toBeInTheDocument();
  });

  it('filters out sessions already known to the store', async () => {
    storeState.sessions = [{ id: 'already-here' }];
    await renderOpen([
      row({ sessionId: 'already-here', title: 'Dup' }),
      row({ sessionId: 'fresh', title: 'New one' }),
    ]);
    expect(screen.queryByText('Dup')).not.toBeInTheDocument();
    expect(screen.getByText('New one')).toBeInTheDocument();
  });

  it('Select-all checks every row and the count flips to N', async () => {
    await renderOpen([
      row({ sessionId: 's1', title: 'one' }),
      row({ sessionId: 's2', title: 'two' }),
      row({ sessionId: 's3', title: 'three' }),
    ]);
    expect(screen.getByText(/0 selected/i)).toBeInTheDocument();
    const selectAll = screen.getByRole('button', { name: /select all/i });
    fireEvent.click(selectAll);
    expect(screen.getByText(/3 selected/i)).toBeInTheDocument();
    // Button flips to deselect all.
    expect(screen.getByRole('button', { name: /deselect all/i })).toBeInTheDocument();
  });

  it('Deselect-all clears the selection after a full-select', async () => {
    await renderOpen([
      row({ sessionId: 's1', title: 'one' }),
      row({ sessionId: 's2', title: 'two' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /deselect all/i }));
    expect(screen.getByText(/0 selected/i)).toBeInTheDocument();
  });

  it('clicking a row toggles its selection', async () => {
    await renderOpen([row({ sessionId: 's1', title: 'pick me' })]);
    const li = screen.getByText('pick me').closest('li')!;
    fireEvent.click(li);
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    fireEvent.click(li);
    expect(screen.getByText(/0 selected/i)).toBeInTheDocument();
  });

  it('the bucket "select group" button picks every row in that bucket', async () => {
    // Two rows in the same bucket (Today) -> one bucket button "Select group".
    await renderOpen([
      row({ sessionId: 's1', title: 'a' }),
      row({ sessionId: 's2', title: 'b' }),
    ]);
    const btn = screen.getByRole('button', { name: /^select group$/i });
    fireEvent.click(btn);
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    // After full bucket selection the button label flips.
    expect(screen.getByRole('button', { name: /^deselect group$/i })).toBeInTheDocument();
  });

  it('collapsing a bucket hides its rows', async () => {
    await renderOpen([row({ sessionId: 's1', title: 'hide me' })]);
    expect(screen.getByText('hide me')).toBeInTheDocument();
    const collapseBtn = screen.getByRole('button', { name: /collapse/i });
    fireEvent.click(collapseBtn);
    expect(screen.queryByText('hide me')).not.toBeInTheDocument();
    // Expand label appears in its place.
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });

  it('primary action is disabled when nothing is selected', async () => {
    await renderOpen([row({ sessionId: 's1', title: 'x' })]);
    const importBtn = screen.getByRole('button', { name: /^Import 0$/ });
    expect((importBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('submit fans out one importSession call per selected row with the full payload', async () => {
    const { onOpenChange } = await renderOpen([
      row({
        sessionId: 'sid-A',
        title: 'titleA',
        cwd: '/work/a',
        projectDir: '-work-a',
      }),
      row({
        sessionId: 'sid-B',
        title: 'titleB',
        cwd: '/work/b',
        projectDir: '-work-b',
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    const importBtn = screen.getByRole('button', { name: /^Import 2$/ });
    await act(async () => {
      fireEvent.click(importBtn);
      await Promise.resolve();
    });
    expect(storeState.importSession).toHaveBeenCalledTimes(2);
    // Each call payload must carry through cwd / title / projectDir /
    // resumeSessionId verbatim — this is the contract reviewer locks down.
    const calls = storeState.importSession.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'titleA',
          cwd: '/work/a',
          projectDir: '-work-a',
          resumeSessionId: 'sid-A',
        }),
        expect.objectContaining({
          name: 'titleB',
          cwd: '/work/b',
          projectDir: '-work-b',
          resumeSessionId: 'sid-B',
        }),
      ])
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('routes imports into the focused group when one is selected', async () => {
    storeState.groups = [
      { id: 'g-focused', name: 'My Group', kind: 'normal' },
      { id: 'g-other', name: 'Imported', kind: 'normal' },
    ];
    storeState.focusedGroupId = 'g-focused';
    await renderOpen([row({ sessionId: 's1', title: 'x' })]);
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
      await Promise.resolve();
    });
    expect(storeState.importSession).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g-focused' })
    );
    expect(storeState.createGroup).not.toHaveBeenCalled();
  });

  it('falls back to the existing "Imported" bucket when no group is focused', async () => {
    storeState.groups = [
      { id: 'g-bucket', name: 'Imported', kind: 'normal' },
      { id: 'g-other', name: 'Other', kind: 'normal' },
    ];
    storeState.focusedGroupId = null;
    await renderOpen([row({ sessionId: 's1', title: 'x' })]);
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
      await Promise.resolve();
    });
    expect(storeState.importSession).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g-bucket' })
    );
    expect(storeState.createGroup).not.toHaveBeenCalled();
  });

  it('creates an "Imported" group when none exists and nothing is focused', async () => {
    storeState.groups = []; // no Imported bucket, no focus
    storeState.focusedGroupId = null;
    storeState.createGroup = vi.fn(() => 'g-newly-made');
    await renderOpen([row({ sessionId: 's1', title: 'x' })]);
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
      await Promise.resolve();
    });
    expect(storeState.createGroup).toHaveBeenCalledWith('Imported');
    expect(storeState.importSession).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g-newly-made' })
    );
  });

  it('ignores a focused archive group (only normal groups receive imports)', async () => {
    storeState.groups = [
      { id: 'g-arch', name: 'Old', kind: 'archive' },
      { id: 'g-bucket', name: 'Imported', kind: 'normal' },
    ];
    storeState.focusedGroupId = 'g-arch';
    await renderOpen([row({ sessionId: 's1', title: 'x' })]);
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
      await Promise.resolve();
    });
    expect(storeState.importSession).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g-bucket' })
    );
  });

  it('submit is a no-op when window.ccsm is missing', async () => {
    // Render with a bridge so we get past loading, then yank it.
    await renderOpen([row({ sessionId: 's1', title: 'x' })]);
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    delete (window as unknown as { ccsm?: unknown }).ccsm;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
      await Promise.resolve();
    });
    expect(storeState.importSession).not.toHaveBeenCalled();
  });

  it('open=false does not trigger a scan', async () => {
    const api = installBridge(() => Promise.resolve([]));
    render(<ImportDialog open={false} onOpenChange={vi.fn()} />);
    expect(api.scanImportable).not.toHaveBeenCalled();
  });

  it('re-opening (open false → true) clears stale selection and re-scans', async () => {
    const rows = [row({ sessionId: 's1', title: 'first' })];
    const api = installBridge(() => Promise.resolve(rows));
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button data-testid="reopen" onClick={() => setOpen((v) => !v)}>x</button>
          <ImportDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }
    await act(async () => {
      render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.scanImportable).toHaveBeenCalledTimes(1);
    // Select everything, then close + reopen.
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('reopen')); // close
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('reopen')); // reopen
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.scanImportable).toHaveBeenCalledTimes(2);
    // Selection reset.
    expect(screen.getByText(/0 selected/i)).toBeInTheDocument();
  });
});

// `within` is unused above but pulled in as an extension point — explicit
// import keeps the lint rule happy if a future test needs scoped queries.
void within;
