// `usePtyAttach.warm.ts` — per-session warm-xterm PTY attach hook.
//
// The only PTY-attach path in the renderer: there is no longer a legacy
// singleton variant or a `CCSM_WARM_XTERM` flag. The warm registry owns
// one xterm Terminal per sid and switching sessions is a wrapper
// reparent, not a teardown.
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
import { warn, log } from '../shared/log';
import {
  applySnapshot,
  disposeEntry,
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

/**
 * Compute the post-attach terminal state for `sid`, accounting for the
 * case where the session ALREADY crashed (either while hidden, or before
 * the attach effect's async chain finished resolving).
 *
 * Second-round cold-review fix (Major): the disconnect-watch effect sets
 * `'exit'` when `disconnectedSessions[sid]` appears, but the attach
 * effect's async tail unconditionally overwrote it with `'ready'`. The
 * `disconnect` object's identity doesn't change across that overwrite, so
 * the watcher's `useEffect([disconnect])` did NOT re-fire — the user
 * was stranded in a `ready` UI for a dead session.
 *
 * The fix is to make the attach effect ALSO read the exit slice
 * synchronously right before its ready transition, and emit `'exit'`
 * instead when an entry exists. Both warm and cold completion paths
 * route through here.
 *
 * Returns the next state plus a flag indicating whether `_clearPtyExit`
 * should fire — we MUST NOT clear when transitioning to 'exit' (it would
 * delete the diagnostic AND make the watcher unable to re-fire because
 * the disconnect object would become undefined → ready → still no
 * re-firing).
 */
function resolveReadyOrExit(
  sessionId: string,
): { next: PtyAttachState; clearExit: boolean; reason: string } {
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
      reason: 'attach-found-existing-exit',
    };
  }
  return {
    next: { kind: 'ready' },
    clearExit: true,
    reason: 'attach-complete',
  };
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
          if (!cancelled) {
            // Major (round 2): if the session already crashed (either
            // while hidden, or while this effect was awaiting), prefer
            // 'exit' over 'ready'. Otherwise the disconnect-watch effect
            // had set 'exit' and we'd be racing it back to 'ready' here
            // with no signal that would re-fire the watcher.
            const decision = resolveReadyOrExit(sessionId);
            setState(decision.next, decision.reason);
            if (decision.clearExit) {
              clearPtyExitRef.current(sessionId);
            }
          }
          return;
        }

        // ===== COLD PATH (entry just allocated) =====
        // The per-entry data listener installed by allocEntry is in
        // 'buffering' mode (Major 1 fix from cold review) — chunks for
        // this sid that arrive between `pty.attach` resolving and the
        // snapshot landing accumulate in the entry's router buffer with
        // their seq, NOT written to term yet. We:
        //   1. attach + spawn-on-null (legacy semantics, unchanged)
        //   2. getBufferSnapshot → `{ snapshot, seq }`
        //   3. term.reset() (clears any pre-listener state; the listener
        //      hasn't written anything yet so reset is safe)
        //   4. term.write(snapshot)
        //   5. registry.applySnapshot(sid, snap.seq) — drains buffered
        //      chunks with seq > snap.seq into term in arrival order,
        //      then flips the listener to 'live' mode (direct write).
        // This is the same dedupe-by-seq contract the legacy path uses,
        // adapted to the per-entry buffering listener.
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
        if (cancelled || requestedSidRef.current !== sessionId) {
          // Minor 4 (cold review): cold attach was cancelled mid-flight
          // (user clicked a different session). The half-initialized
          // entry still holds a buffering listener that's accumulating
          // chunks into router.buffered forever — leaking memory and
          // stranding the next attach in a stale router state. Force-
          // dispose so the next attach to this sid walks the cold path
          // from scratch with a fresh entry+router.
          disposeEntry(sessionId, 'cancelled-mid-cold-attach');
          return;
        }

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
        if (cancelled || requestedSidRef.current !== sessionId) {
          // See Minor 4 rationale above.
          disposeEntry(sessionId, 'cancelled-mid-cold-attach');
          return;
        }

        // Cold-attach paint sequence. The listener is still in 'buffering'
        // mode at this point — nothing it received has been written to
        // term yet. So `term.reset()` is purely defensive (term is fresh
        // from allocEntry); we write the snapshot as the authoritative
        // initial buffer.
        try {
          entry.term.reset();
        } catch {
          /* reset best-effort */
        }
        const snapBytes = snap.snapshot?.length ?? 0;
        const snapWriteStart = Date.now();
        if (snap.snapshot) await writeAsync(entry.term, snap.snapshot);
        const snapWriteEnd = Date.now();

        // Apply the snapshot rendezvous: drains buffered chunks with
        // seq > snap.seq into term, flips listener to 'live'. From this
        // point on, late chunks bypass the buffer and write directly.
        applySnapshot(sessionId, snap.seq);

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
            // Major (round 2): same race as the warm path — if a crash
            // landed in the store while we were in the cold-attach
            // async chain (or fired during the chain itself via the
            // module-level onExit listener), prefer 'exit' over 'ready'.
            // The disconnect-watch effect cannot re-fire on identity-
            // unchanged objects, so the attach effect is the only place
            // that can recover the right state on this path.
            const decision = resolveReadyOrExit(sessionId);
            setState(decision.next, decision.reason);
            if (decision.clearExit) {
              clearPtyExitRef.current(sessionId);
            }
          }
        }
      } catch (err) {
        if (cancelled || requestedSidRef.current !== sessionId) return;
        // Minor 4 (cold review): if the cold path threw (spawn_failed,
        // attach_failed_after_spawn, etc.), the entry is half-initialized
        // and its listener is still buffering. Dispose so the next Retry
        // walks a clean cold path.
        if (isCold) {
          disposeEntry(sessionId, 'cancelled-mid-cold-attach');
        }
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

  // PTY exit watcher (Major 2 fix from cold review).
  //
  // The registry installs a single module-level `pty.onExit` listener
  // that calls `_applyPtyExit(sid, ...)` for EVERY sid unconditionally
  // — so a backgrounded session that crashes lands in
  // `disconnectedSessions[sid]` even though no hook for that sid is
  // visible. Here in the per-hook effect we subscribe to that store
  // slice and flip our local state to `exit` when:
  //   * the current sessionId crashes while visible, OR
  //   * the user switches back to a session that already crashed while
  //     hidden — `disconnectedSessions[sessionId]` is already populated
  //     when this effect first runs, so the state flips immediately.
  //
  // The legacy hook's filter `evt.sessionId !== getActiveSid()` is the
  // exact bug this replaces: it discarded hidden-session exits.
  const disconnect = useStore((s) => s.disconnectedSessions[sessionId]);
  useEffect(() => {
    if (!disconnect) return;
    // Only flip out of 'ready' / 'attaching' to 'exit' — if we're
    // already in 'exit' or 'error' for this sid leave it alone (Retry
    // will clear via _clearPtyExit on success).
    const detail =
      disconnect.signal != null
        ? `signal ${disconnect.signal}`
        : disconnect.code != null
          ? `exit code ${disconnect.code}`
          : 'unknown';
    setState({ kind: 'exit', exitKind: disconnect.kind, detail }, 'pty-exit-watched');
    // disconnect identity changes only when _applyPtyExit / _clearPtyExit
    // fires for this sid — safe dep.
  }, [disconnect, setState]);

  // NOTE: session-deletion is NOT explicitly wired to `disposeEntry` in
  // this initial dogfood version. A deleted session's warm entry will sit
  // idle until LRU evicts it on the WARM_CAP-th new session. Cost is
  // bounded (one Terminal + WriteBuffer per stale entry, capped at
  // WARM_CAP) and the cleanup is observable via the
  // `terminal.warmEvict {cause: 'lru'}` probe. A follow-up PR can wire
  // the store's `deleteSession` action through `disposeEntry` directly
  // if dogfooding shows the memory ceiling is too high.

  // ResizeObserver-driven fit + snapshot replay (gap-8 port from legacy
  // `useTerminalResize`). When the host container changes size (splitter
  // drag, window resize, fullscreen toggle), we:
  //   1. Capture the pre-resize scroll state (atBottom + absolute
  //      viewportY) so a user reading scrolled-up content isn't yanked
  //      to the bottom on every drag tick.
  //   2. Re-fit the entry's term against the new container.
  //   3. Push the new cols/rows to the PTY so claude reflows on the
  //      backend (which also reflows the headless source-of-truth buffer
  //      so subsequent snapshot reads are correctly wrapped).
  //   4. Pull a fresh snapshot and replay it into the visible xterm
  //      (claude's alt-screen TUI doesn't repaint on SIGWINCH until
  //      input arrives — #852 root cause).
  //   5. Restore the pre-resize viewportY if the user was scrolled up.
  //
  // Debounced 80ms so a continuous drag fires one replay per pause, not
  // per pixel. Coalesces overlapping runs via an inFlight latch so two
  // RO ticks back-to-back can't interleave `reset()`s.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let replayInFlight = false;
    let replayPending = false;

    const runResizeReplay = async (): Promise<void> => {
      const pty = window.ccsmPty;
      const entry = getEntry(sessionId);
      if (cancelled || !pty || !entry || !entry.opened) return;
      // Snapshot pre-resize scroll state.
      let wasAtBottom = true;
      let savedViewportY = 0;
      try {
        const buf = entry.term.buffer.active;
        wasAtBottom = buf.baseY - buf.viewportY <= 1;
        savedViewportY = buf.viewportY;
      } catch {
        /* default: assume at-bottom */
      }
      try {
        entry.fit.fit();
      } catch (e) {
        warn('attach-warm', 'resize fit failed', e);
        return;
      }
      const cols = entry.term.cols;
      const rows = entry.term.rows;
      try {
        const p = pty.resize(sessionId, cols, rows);
        if (p && typeof (p as Promise<void>).then === 'function') {
          await (p as Promise<void>);
        }
      } catch (e) {
        warn('attach-warm', 'resize pty.resize failed', e);
      }
      if (cancelled) return;
      // Pull a fresh snapshot from the (now-reflowed) headless buffer
      // and replay it. Same dedupe contract as the cold-attach path —
      // applySnapshot drains live chunks with seq > snap.seq and flips
      // the router back to 'live'.
      let snap: { snapshot: string; seq: number };
      try {
        snap = (await pty.getBufferSnapshot(sessionId)) as {
          snapshot: string;
          seq: number;
        };
      } catch (e) {
        warn('attach-warm', 'resize snapshot fetch failed', e);
        return;
      }
      if (cancelled) return;
      const entry2 = getEntry(sessionId);
      if (!entry2 || !entry2.opened) return;
      try {
        entry2.term.reset();
      } catch (e) {
        warn('attach-warm', 'resize reset failed', e);
      }
      if (snap.snapshot) {
        await new Promise<void>((resolve) => {
          try {
            entry2.term.write(snap.snapshot, () => resolve());
          } catch {
            resolve();
          }
        });
      }
      applySnapshot(sessionId, snap.seq);
      // Drain queued writes before reading viewport state, then restore
      // scroll position.
      await new Promise<void>((resolve) => {
        try {
          entry2.term.write('', () => resolve());
        } catch {
          resolve();
        }
      });
      try {
        if (wasAtBottom) {
          entry2.term.scrollToBottom();
        } else {
          (entry2.term as unknown as {
            scrollToLine?: (n: number) => void;
          }).scrollToLine?.(savedViewportY);
        }
      } catch {
        /* best-effort */
      }
    };

    const scheduleReplay = (): void => {
      if (replayInFlight) {
        replayPending = true;
        return;
      }
      replayInFlight = true;
      void (async () => {
        try {
          await runResizeReplay();
          while (replayPending && !cancelled) {
            replayPending = false;
            await runResizeReplay();
          }
        } finally {
          replayInFlight = false;
          replayPending = false;
        }
      })();
    };

    const ro = new ResizeObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(scheduleReplay, 80);
    });
    ro.observe(host);
    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      ro.disconnect();
    };
  }, [sessionId, hostRef]);

  const onRetry = useCallback(() => {
    setAttachNonce((n) => n + 1);
  }, []);

  return { state, onRetry };
}
