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
  restoreWarmScrollPosition,
  runResizeReplayForEntry,
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
  // Initial state: if the warm registry already has an entry for this
  // sid (e.g. a prior TerminalPane mount for the same sid populated it),
  // start in 'ready' so the first render doesn't briefly show the
  // 'Attaching...' overlay over an already-warmed terminal. Cold mounts
  // start in 'attaching' as before.
  const [state, _setState] = useState<PtyAttachState>(() =>
    getEntry(sessionId) ? { kind: 'ready' } : { kind: 'attaching' },
  );
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
    // NOTE: do NOT setState('attaching') here unconditionally. Warm-cache
    // hits (the common case — user switching back to an already-open
    // session) would briefly render the 'Attaching...' overlay over the
    // already-visible terminal DOM, producing a perceptible flash on
    // every session switch. We defer the attaching transition into the
    // cold branch below so warm hits stay in their prior 'ready' state
    // (or 'exit'/'error' if the prior attach concluded that way) until
    // the new entry is fully swapped in.

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

      // Only flip to 'attaching' for cold attaches (snapshot IPC etc.
      // genuinely take time). Warm hits are a sync reparent + at most
      // one IPC and stay visually continuous.
      if (!existed) {
        setState({ kind: 'attaching' }, 'effect-start');
      }

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
          // its alloc — DOM is already populated, viewport is wherever
          // the user last left it. Switch UX contract: visual swap is
          // instant, no overlay, no scroll, no flash.
          //
          // We still need to (a) fit() locally so the canvas atlas
          // matches the post-reparent host dims, and (b) tell the PTY
          // about any cols/rows change that happened while this entry
          // was offscreen — but BOTH are fire-and-forget. We don't
          // await them before flipping to 'ready'. Reasons:
          //   - The terminal DOM is already showing the correct content.
          //     A stale cols/rows for one PTY tick is harmless (claude
          //     re-wraps on next output).
          //   - Awaiting pty.resize (1 IPC) kept the UI on whatever
          //     prior state (typically 'ready' from the previous warm
          //     hit) for an extra frame, but the cost showed up as a
          //     perceptible delay between sidebar click and the new
          //     terminal feeling "interactive".
          //   - We do NOT call pinViewportToBottom — the entry's
          //     viewport is preserved across hide/show by virtue of
          //     xterm's WriteBuffer staying intact under reparent. The
          //     user expects "where I left it", not "snapped to bottom".
          // DEBUG (task #49): trace viewportY across show → fit → focus →
          // next-frame so we can pinpoint which step is recentering the
          // viewport to the bottom on warm switch.
          const snapVp = (label: string) => {
            try {
              const b = entry.term.buffer?.active;
              log.event('warm.viewport.trace', {
                sid: sessionId,
                step: label,
                viewportY: b?.viewportY ?? -1,
                baseY: b?.baseY ?? -1,
                cursorY: b?.cursorY ?? -1,
                length: b?.length ?? -1,
                cols: entry.term.cols,
                rows: entry.term.rows,
                atBottom: (b?.viewportY ?? 0) === (b?.baseY ?? 0),
              });
            } catch {
              /* probe best-effort */
            }
          };
          snapVp('before-fit');
          try {
            entry.fit.fit();
          } catch (e) {
            warn('attach-warm', 'warm fit failed', e);
          }
          snapVp('after-fit');
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
          // Fire-and-forget: best-effort PTY resize. Idempotent on
          // identical dims, so common-case (no host resize since hide)
          // is a cheap main-side no-op.
          void pty.resize(sessionId, entry.term.cols, entry.term.rows).catch((e) => {
            warn('attach-warm', 'warm resize failed', e);
          });
          try {
            entry.term.focus();
          } catch {
            /* focus best-effort */
          }
          snapVp('after-focus');

          // Restore the user's pre-hide scroll position. Bug #66
          // follow-up: the first attempt at this fix called
          // `term.scrollToLine(savedViewportY)` directly, but `ydisp` is
          // already preserved at `savedViewportY` after the offscreen
          // detour — so `scrollToLine` early-returned (scrollAmount=0),
          // no `onScroll` event fired, and Viewport never re-synced the
          // DOM `.xterm-viewport.scrollTop`. Thumb stuck at the top.
          //
          // The real fix lives in `restoreWarmScrollPosition` (registry
          // module): force a non-zero scroll diff via
          // `scrollToBottom()` + `scrollToLine(target)` so `onScroll`
          // fires and Viewport refreshes the scrollbar thumb to match
          // the painted canvas position. See full rationale in the
          // helper's JSDoc.
          const savedViewportY = entry.savedViewportY;
          if (savedViewportY != null) {
            const savedScrollTop = entry.savedScrollTop ?? -1;
            let vpScrollTop = -1;
            try {
              const vp = entry.wrapper.querySelector('.xterm-viewport');
              if (vp instanceof HTMLElement) vpScrollTop = vp.scrollTop;
            } catch {
              /* probe payload best-effort */
            }
            try {
              restoreWarmScrollPosition(
                entry.term,
                savedViewportY,
                entry.wrapper,
                entry.savedScrollTop,
              );
            } catch (e) {
              warn('attach-warm', 'scroll restore failed', e);
            }
            let restoredViewportY = -1;
            try {
              restoredViewportY = entry.term.buffer.active.viewportY;
            } catch {
              /* probe best-effort */
            }
            try {
              log.event('terminal.warmShow.scrollAfterFit', {
                sid: sessionId,
                savedViewportY,
                restoredViewportY,
                savedScrollTop,
                vpScrollTop,
              });
            } catch {
              /* probe failure tolerated */
            }
            // Clear so a subsequent show without an intervening hide
            // doesn't re-restore a now-stale position (e.g. user scrolls
            // after switch-back, then we re-run this effect for an
            // unrelated dep change — savedViewportY would otherwise pull
            // them back to the pre-hide row).
            entry.savedViewportY = null;
            entry.savedScrollTop = null;
          }
          requestAnimationFrame(() => snapVp('next-frame'));
          setTimeout(() => snapVp('plus-50ms'), 50);
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
        // Don't dispose the entry on a real attach error (e.g. spawn_failed,
        // attach_failed_after_spawn). Keep the wrapper + term mounted so
        // the user sees the error overlay over the existing terminal DOM
        // and can hit Retry without a flash of blank host. The router is
        // left in 'buffering' mode — Retry's cold-attach path will
        // re-resolve `applySnapshot` with the new snapSeq and flush.
        //
        // The mid-cancel dispose paths above (lines guarded by
        // `cancelled || requestedSidRef.current !== sessionId`) still
        // tear down — that's the case the original Minor 4 fix was for
        // (user switched away mid-cold-attach), where keeping the entry
        // would strand a buffering listener for a session nobody is on.
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

    const scheduleReplay = (): void => {
      if (replayInFlight) {
        replayPending = true;
        return;
      }
      replayInFlight = true;
      void (async () => {
        try {
          await runResizeReplayForEntry(sessionId);
          while (replayPending && !cancelled) {
            replayPending = false;
            await runResizeReplayForEntry(sessionId);
          }
        } finally {
          replayInFlight = false;
          replayPending = false;
        }
      })();
    };

    // Gate the replay on actual contentRect dimension change. Warm
    // session switches reparent the entry's wrapper from the offscreen
    // holder back to the live host, but this `host` div (per-pane,
    // observed below) doesn't itself change size — so the offscreen
    // ↔ live transition fires RO with dims identical to the live
    // baseline. Without this gate, every warm switch ran the replay
    // path which calls `entry.term.reset()` and re-applies a snapshot —
    // wiping ydisp/baseY/scrollback. Dogfood frame log on the bug:
    // viewportY 294 → 0, baseY 344 → 0, scrollHeight 6015 → 855 within
    // ~80ms of B→A switch (the RO debounce window). Real user-driven
    // resizes (window resize, splitter drag) still produce dim deltas
    // and trigger the replay as before.
    //
    // First RO callback after observe() is treated as the live baseline
    // (record dims, no replay). Subsequent ticks with identical dims
    // are no-ops; only genuine dim changes schedule the replay.
    let lastW = 0;
    let lastH = 0;
    let roBaseline = false;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (!roBaseline) {
        lastW = w;
        lastH = h;
        roBaseline = true;
        return;
      }
      if (w === lastW && h === lastH) {
        return;
      }
      lastW = w;
      lastH = h;
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
    // Tear down the warm entry so the next attach pass takes the COLD
    // branch (which is the only branch that calls `pty.attach` / `pty.spawn`).
    // Without this, the entry survives `pty.kill`, the effect re-runs into
    // `ensureAndShowEntry` → `isCold=false`, and no fresh PTY ever spawns.
    try {
      disposeEntry(sessionId, 'retry');
    } catch {
      /* registry absent in tests — non-fatal */
    }
    // Clear the disconnect record — otherwise `resolveReadyOrExit` reads
    // the still-populated `disconnectedSessions[sid]` at the end of the
    // cold attach and snaps state right back to 'exit', leaving the
    // overlay visible. See PR #1361 / bug #1360 root cause.
    try {
      clearPtyExitRef.current(sessionId);
    } catch {
      /* slice absent in tests — non-fatal */
    }
    // Flip to attaching synchronously so the exit overlay disappears
    // immediately on click rather than after the async attach resolves.
    setState({ kind: 'attaching' }, 'retry');
    setAttachNonce((n) => n + 1);
  }, [sessionId, setState]);

  return { state, onRetry };
}
