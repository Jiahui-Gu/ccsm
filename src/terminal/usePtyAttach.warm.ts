// `usePtyAttach.warm.ts` — PR #25 warm-xterm variant of `usePtyAttach`.
//
// Activated only when `window.ccsm.featureFlags.warmXterm === true` (env
// flag `CCSM_WARM_XTERM=1`). When the flag is off this file is NEVER
// imported — the legacy `usePtyAttach.ts` remains the default and is
// bit-identical to today.
//
// Architectural contract (per parent decisions, design doc §3):
//   * COLD path (first time we ever see `sid` in this renderer):
//       1. Registry allocates a fresh entry — this installs the
//          per-sid `pty.onData` subscription that writes live chunks
//          to `entry.term` immediately (independent of visibility).
//       2. We reparent the entry's wrapper into the host (showEntry
//          inside `ensureAndShowEntry` does this — visible).
//       3. We resize the entry's term to the spawn cols/rows, run the
//          fit against the live host, push the post-fit cols/rows to
//          the PTY (claude needs SIGWINCH for correct wrapping).
//       4. We pull `getBufferSnapshot` and write it. Because the live
//          listener has ALREADY been writing chunks since step 1,
//          dedupe-by-seq: only write snapshot bytes, then for live
//          chunks emit the same `seq > snap.seq` filter the legacy
//          path uses. We keep the listener's behaviour uniform — the
//          registry subscribed BEFORE attach, so even chunks for the
//          attach prelude land in the WriteBuffer. The snapshot is
//          authoritative; we therefore `term.reset()` BEFORE writing
//          the snapshot and let any post-snap live chunks flow.
//       5. `pinViewportToBottom` rendezvous (same primitive as PR
//          #1352) before flipping state to `ready`.
//
//   * WARM path (entry already exists, user switched back):
//       1. Reparent — that's it.
//       2. `fit()` against the live host (container may have changed
//          size while the entry was hidden), and if the post-fit
//          cols/rows differ from the entry's known PTY size, push a
//          resize.
//       3. `pinViewportToBottom`. Per Q2 parent decision: pin on warm
//          too — matches the #1352 invariant ("at state:ready,
//          viewport === baseY"). Per-session scroll preservation is
//          a future enhancement; user mental model on switch-back is
//          "I want to see fresh content / current prompt."
//       4. Emit `attach.warm.shown` probe (done by registry).
//
//   * NO `pty.detach` ON SESSION SWITCH — the warm entry remains
//     registered with main as an attached webContents so live chunks
//     keep flowing into its xterm. Detach happens only on
//     `disposeEntry` (LRU eviction, session-deleted, or renderer
//     unload).
//
// Transparent-transport invariant: PTY bytes pass through `term.write`
// untouched. No chunking / throttling / rewriting. Only the SUBSCRIPTION
// topology has changed (per-sid filter in registry, not a global active-sid
// filter). The bytes are the same.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { classifyPtyExit } from '../lib/ptyExitClassifier';
import { warn, log } from '../shared/log';
import {
  ensureAndShowEntry,
  getActiveSid,
  getEntry,
} from './xtermWarmRegistry';

const writeAsync = (
  t: { write: (s: string, cb?: () => void) => void },
  s: string,
): Promise<void> => new Promise((resolve) => t.write(s, resolve));

type PinnableTerminal = {
  write: (s: string, cb?: () => void) => void;
  scrollToBottom: () => void;
  buffer: {
    active: {
      viewportY: number;
      baseY: number;
      cursorY: number;
      length: number;
      type: 'normal' | 'alternate';
    };
  };
};

async function pinViewportToBottom(
  term: PinnableTerminal,
  sid: string,
): Promise<void> {
  try {
    await writeAsync(term, '');
  } catch {
    /* best-effort */
  }
  try {
    term.scrollToBottom();
  } catch {
    /* best-effort */
  }
  try {
    const buf = term.buffer.active;
    log.event('attach.invariant.pinned', {
      sid,
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      bufferType: buf.type,
      cursorY: buf.cursorY,
      length: buf.length,
      atBottom: buf.viewportY === buf.baseY,
    });
  } catch {
    /* probe must not break attach */
  }
}

export type PtyAttachState =
  | { kind: 'attaching' }
  | { kind: 'ready' }
  | { kind: 'exit'; exitKind: 'clean' | 'crashed'; detail: string }
  | { kind: 'error'; message: string };

export type UsePtyAttachResult = {
  state: PtyAttachState;
  onRetry: () => void;
};

/**
 * Warm-xterm variant of `usePtyAttach`. See module header for contract.
 *
 * `hostRef` is the same TerminalPane host div that the singleton path
 * uses as its xterm parent. In the warm path it's the reparent target
 * for the entry's wrapper.
 */
export function usePtyAttachWarm(
  sessionId: string,
  cwd: string,
  hostRef: { current: HTMLDivElement | null },
): UsePtyAttachResult {
  const [state, _setState] = useState<PtyAttachState>({ kind: 'attaching' });
  const setState = useCallback(
    (next: PtyAttachState, reason?: string): void => {
      _setState((prev) => {
        try {
          log.event('attach.state.transition', {
            sid: requestedSidRef.current,
            from: prev.kind,
            to: next.kind,
            reason: reason ?? next.kind,
          });
        } catch {
          /* logging must never break the state machine */
        }
        return next;
      });
    },
    [],
  );
  const clearPtyExit = useStore((s) => s._clearPtyExit);
  const clearPtyExitRef = useRef(clearPtyExit);
  clearPtyExitRef.current = clearPtyExit;
  const requestedSidRef = useRef<string>(sessionId);
  const [attachNonce, setAttachNonce] = useState(0);
  const reloadNonce = useStore((s) => s.reloadNonce?.[sessionId] ?? 0);

  useEffect(() => {
    requestedSidRef.current = sessionId;
    let cancelled = false;
    const attachStartedAt = Date.now();
    setState({ kind: 'attaching' }, 'effect-start');

    (async () => {
      const pty = window.ccsmPty;
      if (!pty) {
        if (!cancelled) setState({ kind: 'error', message: 'ccsmPty unavailable' }, 'no-bridge');
        return;
      }
      const host = hostRef.current;
      if (!host) {
        if (!cancelled) setState({ kind: 'error', message: 'no-host' }, 'no-host');
        return;
      }

      // Warm cache lookup BEFORE we touch the registry — needed so we
      // can branch on warm vs cold. ensureAndShowEntry below would
      // hide this signal (it allocates on cache miss).
      const existed = !!getEntry(sessionId);

      // Reparent (or allocate-then-parent) the entry into our host. The
      // registry handles the activeSid update, hides the previous active
      // entry, fires the `attach.warm.shown` probe on cache hit.
      const cause =
        attachNonce > 0 || reloadNonce > 0 ? 'retry' : existed ? 'session-switch' : 'mount';
      const { entry, isCold } = ensureAndShowEntry(sessionId, host, cause);
      if (cancelled || requestedSidRef.current !== sessionId) return;

      try {
        if (!isCold) {
          // ===== WARM PATH =====
          // The entry's term has been receiving live PTY chunks since
          // its alloc. Reparent already happened; just fit + pin.
          try {
            entry.fit.fit();
          } catch (e) {
            warn('attach-warm', 'warm fit failed', e);
          }
          try {
            log.event('attach.fit.applied', {
              sid: sessionId,
              cols: entry.term.cols,
              rows: entry.term.rows,
              ptyResized: false,
            });
          } catch {
            /* probe failure tolerated */
          }
          // Push container size to PTY so claude resizes if the host
          // dimensions changed while this entry was offscreen. Best-effort;
          // resize IPC is idempotent on identical dims.
          try {
            await pty.resize(sessionId, entry.term.cols, entry.term.rows);
          } catch (e) {
            warn('attach-warm', 'warm resize failed', e);
          }
          if (cancelled || requestedSidRef.current !== sessionId) return;
          try {
            entry.term.focus();
          } catch {
            /* focus best-effort */
          }
          await pinViewportToBottom(
            entry.term as unknown as PinnableTerminal,
            sessionId,
          );
          if (!cancelled) setState({ kind: 'ready' }, 'attach-warm-complete');
          clearPtyExitRef.current(sessionId);
          return;
        }

        // ===== COLD PATH (entry just allocated) =====
        // Mirror the legacy `usePtyAttach` cold attach flow but target
        // `entry.term` instead of the singleton. The per-entry pty.onData
        // listener (installed in allocEntry) is ALREADY writing live
        // chunks to entry.term. We treat the snapshot as authoritative
        // and reset the term before writing it — the live tail that the
        // subscription has been writing into the term up to this point
        // will be a strict prefix of (or identical to) the snapshot, so
        // resetting + writing snapshot produces the correct end state.
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
            const reason =
              spawnResult && spawnResult.ok === false ? spawnResult.error : 'spawn_failed';
            throw new Error(reason);
          }
          res = (await pty.attach(sessionId)) as
            | { cols: number; rows: number; pid: number }
            | null;
          if (!res) throw new Error('attach_failed_after_spawn');
        }
        const { cols, rows } = res;
        if (cancelled || requestedSidRef.current !== sessionId) return;

        // Resize entry's term to PTY's current size BEFORE snapshot write
        // so the cell grid matches the snapshot dimensions.
        try {
          entry.term.resize(cols, rows);
        } catch {
          /* resize best-effort */
        }

        const snap = (await pty.getBufferSnapshot(sessionId)) as {
          snapshot: string;
          seq: number;
        };
        if (cancelled || requestedSidRef.current !== sessionId) return;

        // Reset to drop the prefix that the per-entry listener wrote
        // before the snapshot arrived, then write the snapshot as the
        // authoritative starting buffer. Subsequent live chunks (from
        // the registry's per-entry subscription) continue to flow into
        // the term naturally — no second listener needed.
        try {
          entry.term.reset();
        } catch {
          /* reset best-effort */
        }
        const snapBytes = snap.snapshot?.length ?? 0;
        const snapWriteStart = Date.now();
        if (snap.snapshot) await writeAsync(entry.term, snap.snapshot);
        const snapWriteEnd = Date.now();
        const bufA = entry.term.buffer?.active;
        try {
          log.event('attach.snapshot.applied', {
            sid: sessionId,
            bytes: snapBytes,
            durationMs: snapWriteEnd - snapWriteStart,
            viewportYBefore: 0,
            viewportYAfter: bufA?.viewportY ?? 0,
            baseY: bufA?.baseY ?? 0,
          });
        } catch {
          /* probe failure tolerated */
        }

        try {
          log.event('attach.scrollToBottom.invoked', {
            sid: sessionId,
            callsite: 'post-snap',
            viewportY: bufA?.viewportY ?? 0,
            baseY: bufA?.baseY ?? 0,
            bufferType: bufA?.type ?? 'normal',
            cursorY: bufA?.cursorY ?? 0,
            length: bufA?.length ?? 0,
            atBottom: (bufA?.viewportY ?? 0) === (bufA?.baseY ?? 0),
          });
        } catch {
          /* probe failure tolerated */
        }
        try {
          entry.term.scrollToBottom();
        } catch {
          /* best-effort */
        }

        // Wire term.onData → pty.input for the active sid. The disposable
        // lives on the entry (we don't dispose it on switch — input from a
        // non-focused hidden term cannot occur because focus follows
        // visibility).
        const inputDisposable = entry.term.onData((data: string) => {
          if (getActiveSid() === sessionId) {
            window.ccsmPty.input(sessionId, data);
          }
        });
        // Stash on entry for later disposal via a closure (no extra field).
        const origUnsub = entry.dataUnsubscribe;
        entry.dataUnsubscribe = () => {
          try {
            inputDisposable.dispose();
          } catch {
            /* ignore */
          }
          try {
            origUnsub();
          } catch {
            /* ignore */
          }
        };

        // Post-attach fit + resize push, matching the legacy gate: only
        // pty.resize when the post-fit dims actually differ from the
        // spawn cols/rows. Skip the snapshot replay sub-flow — the live
        // listener will paint subsequent chunks correctly at the new
        // size since claude will re-emit on SIGWINCH.
        try {
          entry.fit.fit();
          const newCols = entry.term.cols;
          const newRows = entry.term.rows;
          const ptyResized = newCols !== cols || newRows !== rows;
          try {
            log.event('attach.fit.applied', {
              sid: sessionId,
              cols: newCols,
              rows: newRows,
              ptyResized,
            });
          } catch {
            /* probe failure tolerated */
          }
          if (ptyResized) {
            try {
              await pty.resize(sessionId, newCols, newRows);
            } catch (e) {
              warn('attach-warm', 'post-attach resize failed', e);
            }
          }
        } catch (e) {
          warn('attach-warm', 'post-attach fit failed', e);
          try {
            log.event('attach.fit.skipped', { sid: sessionId, reason: 'exception' });
          } catch {
            /* probe failure tolerated */
          }
        }

        try {
          entry.term.focus();
        } catch (e) {
          warn('attach-warm', 'focus failed', e);
        }

        if (!cancelled) {
          await pinViewportToBottom(
            entry.term as unknown as PinnableTerminal,
            sessionId,
          );
          if (!cancelled) {
            // Log first-write-after-attach probe as a synthesised value
            // since we don't gate it on the listener — it's effectively
            // the snapshot write itself.
            try {
              log.event('term.firstWrite.afterAttach', {
                sid: sessionId,
                bytes: snapBytes,
                durationMsSinceAttach: Date.now() - attachStartedAt,
              });
            } catch {
              /* probe failure tolerated */
            }
            setState({ kind: 'ready' }, 'attach-cold-complete');
          }
        }
        clearPtyExitRef.current(sessionId);
      } catch (err) {
        if (cancelled || requestedSidRef.current !== sessionId) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message }, 'attach-threw');
      }
    })();

    return () => {
      cancelled = true;
      // INTENTIONAL: no pty.detach on sid switch. The warm entry keeps
      // its main-side webContents registration so live chunks continue
      // to land in entry.term while hidden — that's the entire point of
      // the warm cache. detach happens only on `disposeEntry` (LRU,
      // session-deleted, or renderer unload).
    };
  }, [sessionId, attachNonce, reloadNonce, cwd, setState, hostRef]);

  useEffect(() => {
    const pty = window.ccsmPty;
    if (!pty?.onExit) return;
    const unsubscribe = pty.onExit(
      (evt: { sessionId: string; code?: number | null; signal?: string | number | null }) => {
        if (evt.sessionId !== getActiveSid()) return;
        const signal = evt.signal ?? null;
        const code = evt.code ?? null;
        const exitKind = classifyPtyExit({ code, signal });
        const detail =
          signal != null
            ? `signal ${signal}`
            : code != null
              ? `exit code ${code}`
              : 'unknown';
        setState({ kind: 'exit', exitKind, detail }, 'pty-exit');
      },
    );
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* already torn down */
      }
    };
  }, [setState]);

  // NOTE: session-deletion is NOT explicitly wired to `disposeEntry` in
  // this initial dogfood version. A deleted session's warm entry will sit
  // idle until LRU evicts it on the WARM_CAP-th new session. Cost is
  // bounded (one Terminal + WriteBuffer per stale entry, capped at
  // WARM_CAP) and the cleanup is observable via the
  // `terminal.warmEvict {cause: 'lru'}` probe. A follow-up PR can wire
  // the store's `deleteSession` action through `disposeEntry` directly
  // if dogfooding shows the memory ceiling is too high.

  const onRetry = useCallback(() => {
    setAttachNonce((n) => n + 1);
  }, []);

  return { state, onRetry };
}
