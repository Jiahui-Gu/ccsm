import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../src/stores/store';
import type { Session } from '../src/types';

// Covers the three outcomes of `renameSession` SDK writeback wired in PR2:
//   1. ok          → local name updated, no enqueue
//   2. no_jsonl    → local name updated, enqueuePending called
//   3. sdk_threw   → local name updated, enqueuePending NOT called, console.error
//
// `window.ccsmSessionTitles` is the IPC bridge created in `electron/preload.ts`;
// jsdom doesn't expose it by default. We install a mock per case and tear it
// down after each test so other tests aren't polluted.

type RenameResult =
  | { ok: true }
  | { ok: false; reason: 'no_jsonl' | 'sdk_threw'; message?: string };

function installBridge(rename: (sid: string, title: string, dir?: string) => Promise<RenameResult>) {
  const enqueuePending = vi.fn(async () => {});
  const flushPending = vi.fn(async () => {});
  const get = vi.fn(async () => ({ summary: null, mtime: null }));
  const listForProject = vi.fn(async () => []);
  (window as unknown as { ccsmSessionTitles: unknown }).ccsmSessionTitles = {
    rename: vi.fn(rename),
    enqueuePending,
    flushPending,
    get,
    listForProject,
  };
  return { enqueuePending, flushPending };
}

function seedSession(id: string, name: string, cwd: string): void {
  const session: Session = {
    id,
    name,
    state: 'idle',
    cwd,
    model: '',
    groupId: 'g1',
    agentType: 'claude-code',
  };
  useStore.setState((s) => ({ sessions: [...s.sessions, session] }));
}

describe('store.renameSession (SDK writeback)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Wipe sessions from prior cases so id collisions can't pollute.
    useStore.setState({ sessions: [] });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles;
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    useStore.setState({ sessions: [] });
  });

  it('ok: local name updated, no enqueue', async () => {
    const { enqueuePending } = installBridge(async () => ({ ok: true }));
    seedSession('sid-ok', 'old', '/tmp/proj-ok');

    await useStore.getState().renameSession('sid-ok', 'fresh-title');

    const after = useStore.getState().sessions.find((s) => s.id === 'sid-ok');
    expect(after?.name).toBe('fresh-title');
    expect(enqueuePending).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no_jsonl: local name updated, enqueuePending called with cwd', async () => {
    const { enqueuePending } = installBridge(async () => ({
      ok: false,
      reason: 'no_jsonl',
    }));
    seedSession('sid-pending', 'old', '/tmp/proj-pending');

    await useStore.getState().renameSession('sid-pending', 'queued-title');

    const after = useStore.getState().sessions.find((s) => s.id === 'sid-pending');
    expect(after?.name).toBe('queued-title');
    expect(enqueuePending).toHaveBeenCalledTimes(1);
    expect(enqueuePending).toHaveBeenCalledWith(
      'sid-pending',
      'queued-title',
      '/tmp/proj-pending'
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sdk_threw: local name updated, no enqueue, error logged', async () => {
    const { enqueuePending } = installBridge(async () => ({
      ok: false,
      reason: 'sdk_threw',
      message: 'EACCES',
    }));
    seedSession('sid-threw', 'old', '/tmp/proj-threw');

    await useStore.getState().renameSession('sid-threw', 'attempted');

    const after = useStore.getState().sessions.find((s) => s.id === 'sid-threw');
    expect(after?.name).toBe('attempted');
    expect(enqueuePending).not.toHaveBeenCalled();
    // sdk_threw escalates to console.error (not warn) so dogfood actually
    // sees writeback regressions instead of silently shipping a UI-vs-JSONL
    // split-brain (eval #647 root cause).
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('sid-threw');
    expect(String(errorSpy.mock.calls[0][0])).toContain('rename:writeback-failed');
  });

  it('local update happens even before the SDK promise resolves (optimistic)', async () => {
    let releaseSdk: (r: RenameResult) => void = () => {};
    const sdkPromise = new Promise<RenameResult>((resolve) => {
      releaseSdk = resolve;
    });
    installBridge(() => sdkPromise);
    seedSession('sid-opt', 'old', '/tmp/proj-opt');

    const renamePromise = useStore.getState().renameSession('sid-opt', 'instant');
    // Synchronously after the call returns its first microtask we should
    // see the new name; the SDK promise hasn't resolved yet.
    await Promise.resolve();
    expect(
      useStore.getState().sessions.find((s) => s.id === 'sid-opt')?.name
    ).toBe('instant');

    releaseSdk({ ok: true });
    await renamePromise;
  });

  it('no bridge available: local update still applies (test/jsdom path)', async () => {
    // Ensure no bridge is installed.
    delete (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles;
    seedSession('sid-no-bridge', 'old', '/tmp/proj-nb');

    await useStore.getState().renameSession('sid-no-bridge', 'local-only');

    expect(
      useStore.getState().sessions.find((s) => s.id === 'sid-no-bridge')?.name
    ).toBe('local-only');
  });
});
