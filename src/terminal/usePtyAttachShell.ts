// `usePtyAttachShell` — the renderer's attach orchestration hook post
// attach-redesign. Built on `shellRegistry`. See `docs/attach-redesign.html`.
//
// Two paths, no machinery:
//
//   COLD (no shell yet for this sid):
//     1. createShell(sid, host)   — builds wrapper + xterm.open + input
//                                   listeners + mask ON. No PTY listener.
//     2. pty.attach(sid)          — spawn-on-null falls back to pty.spawn.
//     3. pty.getBufferSnapshot     — captured atomically with main's seq.
//     4. term.reset() + write     — paint the snapshot.
//     5. subscribeShellData(sid)  — PTY listener writes live chunks to term.
//     6. fit + pty.resize (best-effort) + setMask(sid, false) → ready.
//
//   VISITED (shell exists):
//     1. showShell(sid)            — z-stack flip, no mask.
//     2. fit() + best-effort pty.resize for any container size change.
//     3. ready immediately.
//
// Reload (sessionRuntimeSlice.reloadSession bumps reloadNonce):
//   - reload of top: resetShellForReload(sid) shows mask, then cold-start
//     suffix (attach → snapshot → write → unmask).
//   - reload of hidden: same shape but mask stays off the whole time
//     because the shell isn't on top.
//
// Bailout: any throw → setState('error') + disposeShell(sid). User taps
// Retry → onRetry calls disposeShell + sets a nonce so the effect re-runs
// from scratch (i.e., cold-starts a fresh shell).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { warn, log } from '../shared/log';
import {
  createShell,
  disposeShell,
  getShell,
  resetShellForReload,
  setMask,
  showShell,
  subscribeShellData,
  type Shell,
} from './shellRegistry';

export type PtyAttachState =
  | { kind: 'attaching' }
  | { kind: 'ready' }
  | { kind: 'exit'; exitKind: 'clean' | 'crashed'; detail: string }
  | { kind: 'error'; message: string };

export type UsePtyAttachResult = {
  state: PtyAttachState;
  onRetry: () => void;
};

function resolveReadyOrExit(
  sessionId: string,
): { next: PtyAttachState; clearExit: boolean } {
  const exitInfo = useStore.getState().disconnectedSessions[sessionId];
  if (exitInfo) {
    const detail =
      exitInfo.signal != null
        ? `signal ${exitInfo.signal}`
        : exitInfo.code != null
          ? `exit code ${exitInfo.code}`
          : 'unknown';
    return {
      next: { kind: 'exit', exitKind: exitInfo.kind, detail },
      clearExit: false,
    };
  }
  return { next: { kind: 'ready' }, clearExit: true };
}

const writeAsync = (
  t: { write: (s: string, cb?: () => void) => void },
  s: string,
): Promise<void> => new Promise((resolve) => t.write(s, resolve));

/**
 * The "attach → snapshot → write → subscribe → unmask" sequence shared
 * between the cold path (new shell) and the reload path (existing shell
 * whose term was just term.reset()'d). Throws on any failure so the
 * caller can `disposeShell` + setState('error').
 */
async function runColdStartSuffix(
  sessionId: string,
  cwd: string,
  shell: Shell,
): Promise<void> {
  const pty = window.ccsmPty;
  if (!pty) throw new Error('ccsmPty unavailable');

  let res = (await pty.attach(sessionId)) as
    | { cols: number; rows: number; pid: number }
    | null;
  if (!res) {
    const forkSourceSid =
      useStore.getState().pendingForkSource[sessionId] ?? undefined;
    const spawnResult = (await pty.spawn(sessionId, cwd ?? '', forkSourceSid)) as
      | { ok: true; sid: string; pid: number; cols: number; rows: number }
      | { ok: false; error: string };
    if (forkSourceSid) {
      useStore.setState((s) => {
        if (!s.pendingForkSource[sessionId]) return {};
        const next = { ...s.pendingForkSource };
        delete next[sessionId];
        return { pendingForkSource: next };
      });
    }
    if (!spawnResult || spawnResult.ok === false) {
      throw new Error(
        spawnResult && spawnResult.ok === false ? spawnResult.error : 'spawn_failed',
      );
    }
    res = (await pty.attach(sessionId)) as
      | { cols: number; rows: number; pid: number }
      | null;
    if (!res) throw new Error('attach_failed_after_spawn');
  }

  try {
    shell.term.resize(res.cols, res.rows);
  } catch {
    /* best-effort */
  }

  const snap = (await pty.getBufferSnapshot(sessionId)) as {
    snapshot: string;
    seq: number;
  };
  try {
    shell.term.reset();
  } catch {
    /* best-effort */
  }
  if (snap.snapshot) await writeAsync(shell.term, snap.snapshot);

  // Subscribe AFTER the snapshot write — no buffering mode (design §3).
  subscribeShellData(sessionId);
  shell.warmed = true;

  // Wire term.onData → pty.input. Idempotent across reload because the
  // shell's previous inputDisposable was either left in place (we keep
  // the term across reloads) — guard by stashing once.
  const stashKey = '__ccsmInputWired' as const;
  type Stashed = { [stashKey]: boolean };
  if (!(shell as unknown as Stashed)[stashKey]) {
    const inputDisposable = shell.term.onData((data: string) => {
      if (getShell(sessionId)) window.ccsmPty.input(sessionId, data);
    });
    shell.inputDisposers.push(() => {
      try {
        inputDisposable.dispose();
      } catch {
        /* ignore */
      }
    });
    (shell as unknown as Stashed)[stashKey] = true;
  }

  try {
    shell.fit.fit();
    const newCols = shell.term.cols;
    const newRows = shell.term.rows;
    if (newCols !== res.cols || newRows !== res.rows) {
      await pty.resize(sessionId, newCols, newRows).catch(() => {});
    }
  } catch (e) {
    warn('attach-shell', 'post-attach fit failed', e);
  }

  try {
    shell.term.scrollToBottom();
  } catch {
    /* best-effort */
  }
  try {
    shell.term.focus();
  } catch {
    /* best-effort */
  }

  setMask(sessionId, false);

  try {
    log.event('attach.cold.complete', {
      sid: sessionId,
      snapshotBytes: snap.snapshot?.length ?? 0,
    });
  } catch {
    /* probe best-effort */
  }
}

export function usePtyAttachShell(
  sessionId: string,
  cwd: string,
  hostRef: { current: HTMLDivElement | null },
): UsePtyAttachResult {
  // Visited sids start ready (the shell is already alive); cold sids start
  // attaching so the overlay logic in TerminalPane can react if needed.
  const [state, setState] = useState<PtyAttachState>(() =>
    getShell(sessionId) ? { kind: 'ready' } : { kind: 'attaching' },
  );
  const clearPtyExit = useStore((s) => s._clearPtyExit);
  const clearPtyExitRef = useRef(clearPtyExit);
  clearPtyExitRef.current = clearPtyExit;
  const [retryNonce, setRetryNonce] = useState(0);
  const reloadNonce = useStore((s) => s.reloadNonce?.[sessionId] ?? 0);

  // Distinguish "fresh effect run because reloadNonce bumped" from
  // "fresh effect run because the user switched sessions". Track the last
  // applied (sessionId, reloadNonce) pair: on a sessionId change the ref
  // resets so a brand-new sid never falsely reads as "mid-reload".
  const lastReloadAppliedRef = useRef<{ sid: string; nonce: number }>({
    sid: sessionId,
    nonce: reloadNonce,
  });

  useEffect(() => {
    let cancelled = false;
    const last = lastReloadAppliedRef.current;
    const isReload =
      last.sid === sessionId &&
      reloadNonce !== last.nonce &&
      getShell(sessionId) != null;
    lastReloadAppliedRef.current = { sid: sessionId, nonce: reloadNonce };

    void (async () => {
      const pty = window.ccsmPty;
      if (!pty) {
        if (!cancelled) setState({ kind: 'error', message: 'ccsmPty unavailable' });
        return;
      }
      const host = hostRef.current;
      if (!host) {
        if (!cancelled) setState({ kind: 'error', message: 'no-host' });
        return;
      }

      // RELOAD path — sessionRuntimeSlice already killed the PTY; we
      // term.reset() the shell, mask if top, then run cold-start suffix
      // against the freshly spawned PTY.
      if (isReload) {
        const shell = resetShellForReload(sessionId);
        if (!shell) return;
        setState({ kind: 'attaching' });
        try {
          await runColdStartSuffix(sessionId, cwd, shell);
          if (!cancelled) {
            const decision = resolveReadyOrExit(sessionId);
            setState(decision.next);
            if (decision.clearExit) clearPtyExitRef.current(sessionId);
          }
        } catch (err) {
          if (cancelled) return;
          try {
            disposeShell(sessionId);
          } catch {
            /* ignore */
          }
          const message = err instanceof Error ? err.message : String(err);
          setState({ kind: 'error', message });
        }
        return;
      }

      // VISITED path — shell exists, no cold start, no mask.
      const existing = getShell(sessionId);
      if (existing) {
        showShell(sessionId);
        try {
          existing.fit.fit();
          void pty.resize(sessionId, existing.term.cols, existing.term.rows).catch(() => {});
          existing.term.focus();
        } catch (e) {
          warn('attach-shell', 'visited path post-show ops failed', e);
        }
        if (!cancelled) {
          const decision = resolveReadyOrExit(sessionId);
          setState(decision.next);
          if (decision.clearExit) clearPtyExitRef.current(sessionId);
        }
        try {
          log.event('attach.visited.shown', { sid: sessionId });
        } catch {
          /* probe best-effort */
        }
        return;
      }

      // COLD path — build the shell, mask covers it during ipc work.
      setState({ kind: 'attaching' });
      const shell = createShell(sessionId, host);
      try {
        await runColdStartSuffix(sessionId, cwd, shell);
        if (!cancelled) {
          const decision = resolveReadyOrExit(sessionId);
          setState(decision.next);
          if (decision.clearExit) clearPtyExitRef.current(sessionId);
        }
      } catch (err) {
        if (cancelled) return;
        try {
          disposeShell(sessionId);
        } catch {
          /* ignore */
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, retryNonce, reloadNonce, cwd, hostRef]);

  // PTY exit watcher — single store subscription, no per-sid filtering.
  const disconnect = useStore((s) => s.disconnectedSessions[sessionId]);
  useEffect(() => {
    if (!disconnect) return;
    const detail =
      disconnect.signal != null
        ? `signal ${disconnect.signal}`
        : disconnect.code != null
          ? `exit code ${disconnect.code}`
          : 'unknown';
    setState({ kind: 'exit', exitKind: disconnect.kind, detail });
  }, [disconnect]);

  // Resize observer — host changed size (splitter drag, window resize).
  // Refit + pty.resize, fire-and-forget. No snapshot replay: claude
  // re-emits on SIGWINCH and the live PTY subscription paints the result.
  // If the user notices a stale frame, the bailout is dispose+retry.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let lastW = 0;
    let lastH = 0;
    let baseline = false;
    const apply = () => {
      const shell = getShell(sessionId);
      if (!shell) return;
      try {
        shell.fit.fit();
        const cols = shell.term.cols;
        const rows = shell.term.rows;
        window.ccsmPty?.resize(sessionId, cols, rows).catch(() => {});
      } catch (e) {
        warn('attach-shell', 'resize apply failed', e);
      }
    };
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (!baseline) {
        baseline = true;
        lastW = w;
        lastH = h;
        return;
      }
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(apply, 80);
    });
    ro.observe(host);
    return () => {
      if (debounce) clearTimeout(debounce);
      ro.disconnect();
    };
  }, [sessionId, hostRef]);

  const onRetry = useCallback(() => {
    try {
      disposeShell(sessionId);
    } catch {
      /* ignore */
    }
    try {
      clearPtyExitRef.current(sessionId);
    } catch {
      /* ignore */
    }
    setState({ kind: 'attaching' });
    setRetryNonce((n) => n + 1);
  }, [sessionId]);

  return { state, onRetry };
}

/**
 * Reload entry-point used by `sessionRuntimeSlice.reloadSession`. Caller
 * has already killed the PTY and bumped `reloadNonce`. We reset the
 * shell's terminal in place + show its mask if it's the top — the
 * attach effect's reload-trigger re-runs the cold-start suffix
 * (snapshot fetch + write) against the freshly spawned PTY.
 *
 * This is invoked from the store slice but expressed as a free function
 * so the slice doesn't import React.
 */
export function prepareShellForReload(sid: string): void {
  if (getShell(sid)) {
    resetShellForReload(sid);
  }
}
