import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { classifyPtyExit } from '../lib/ptyExitClassifier';
import {
  getTerm,
  getFit,
  getActiveSid,
  setActiveSid,
  getUnsubscribeData,
  setUnsubscribeData,
  getInputDisposable,
  setInputDisposable,
  setSnapshotReplay,
  getSnapshotReplay,
} from './xtermSingleton';

export type PtyAttachState =
  | { kind: 'attaching' }
  | { kind: 'ready' }
  // `exit` distinguishes user-intentional clean exit (no signal, code 0)
  // from a crash. The former renders a neutral overlay + "claude exited"
  // copy; the latter renders the red overlay + "claude crashed... not a
  // ccsm bug" copy. Both show Retry. The legacy `error` shape stays for
  // spawn/attach failures (spawn IPC returned !ok, ccsmPty unavailable,
  // etc.) which are NOT pty exits.
  | { kind: 'exit'; exitKind: 'clean' | 'crashed'; detail: string }
  | { kind: 'error'; message: string };

export type UsePtyAttachResult = {
  state: PtyAttachState;
  onRetry: () => void;
};

/**
 * Owns the PTY lifecycle for a given sessionId:
 *   1. On sessionId (or Retry) change: detach previous, reset terminal,
 *      attach new (with spawn-on-null fallback), write snapshot, wire
 *      onData both directions, fit, focus.
 *   2. Subscribes to `pty.onExit` for the active sid → flips state to
 *      `exit` with classification (clean vs crashed) consistent with
 *      `classifyPtyExit` so the overlay and the sidebar red-dot signal
 *      stay aligned.
 *   3. On successful (re-)attach, clears any stale disconnect entry from
 *      the store so the sidebar red dot disappears.
 *
 * Returns `{ state, onRetry }` for the host component to render the
 * appropriate overlay (attaching / error / exit) and Retry button.
 */
export function usePtyAttach(sessionId: string, cwd: string): UsePtyAttachResult {
  const [state, setState] = useState<PtyAttachState>({ kind: 'attaching' });
  // Store action — clear the disconnect entry on respawn success so the
  // sidebar red dot disappears the moment the pty is back. Routed through
  // a ref so the attach effect doesn't depend on it (and re-run unnecessarily).
  const clearPtyExit = useStore((s) => s._clearPtyExit);
  const clearPtyExitRef = useRef(clearPtyExit);
  clearPtyExitRef.current = clearPtyExit;
  // Tracks the sessionId we're currently attaching for so a stale resolve
  // from a previous session can't clobber the current one when the user
  // switches quickly.
  const requestedSidRef = useRef<string>(sessionId);
  // Bumped by Retry to force the attach effect to re-run for the same sid.
  const [attachNonce, setAttachNonce] = useState(0);

  // Attach effect: on sessionId change (or Retry), detach the previous
  // session, reset the terminal, attach the new one, and wire data flow.
  useEffect(() => {
    requestedSidRef.current = sessionId;
    let cancelled = false;
    setState({ kind: 'attaching' });

    (async () => {
      const pty = window.ccsmPty;
      if (!pty) {
        if (!cancelled) setState({ kind: 'error', message: 'ccsmPty unavailable' });
        return;
      }

      const prevSid = getActiveSid();
      if (prevSid && prevSid !== sessionId) {
        // L4 PR-D (#866): the previous attach's snapshot-replay closure is
        // bound to the prev sid — drop it before installing the new one.
        setSnapshotReplay(null);
        const unsub = getUnsubscribeData();
        if (unsub) {
          try {
            unsub();
          } catch {
            // already torn down — safe to ignore.
          }
          setUnsubscribeData(null);
        }
        const inDisp = getInputDisposable();
        if (inDisp) {
          try {
            inDisp.dispose();
          } catch {
            // already disposed — safe to ignore.
          }
          setInputDisposable(null);
        }
        try {
          await pty.detach(prevSid);
        } catch {
          // detach failure is non-fatal — main may already have torn it down.
        }
      } else if (prevSid === sessionId) {
        // Same sid (Retry path): tear down stale subscriptions before re-attaching
        // so we don't double-write incoming chunks.
        // L4 PR-D (#866): also drop the prior attach's replay handler so a
        // resize during re-attach doesn't fire against the stale closure.
        setSnapshotReplay(null);
        const unsub = getUnsubscribeData();
        if (unsub) {
          try {
            unsub();
          } catch {
            // already torn down — safe to ignore.
          }
          setUnsubscribeData(null);
        }
        const inDisp = getInputDisposable();
        if (inDisp) {
          try {
            inDisp.dispose();
          } catch {
            // already disposed — safe to ignore.
          }
          setInputDisposable(null);
        }
      }

      if (cancelled || requestedSidRef.current !== sessionId) return;

      const term = getTerm();
      if (term) term.reset();

      // L4 PR-F (#867): the spawn-time cols/rows hack added for #852 is gone.
      // The PTY launches at the lifecycle defaults (120x30); the post-attach
      // resize+replay below (PR-D #866) reflows the headless source-of-truth
      // buffer to the real viewport size and rewrites the visible xterm from
      // it, so there is no longer a "spawn at wrong size → claude's alt-screen
      // never repaints → bottom-black-void" divergence even when the visible
      // viewport differs from the spawn size. The pre-spawn FitAddon
      // proposeDimensions() call + pre-write `term.resize` are likewise no
      // longer needed: the post-attach fit reads the live container, the
      // backend resize reflows the headless buffer, and the snapshot replay
      // paints the reflowed grid.

      try {
        // Spawn-on-attach-null fallback. The renderer drives session
        // lifecycle, so an attach against a sid main has not seen yet
        // returns null — we then ask main to spawn the pty (using the
        // session's cwd) and re-attach. Subsequent attaches reuse the
        // existing pty (spawnPtySession is idempotent on sid).
        let res = (await pty.attach(sessionId)) as
          | { snapshot: string; cols: number; rows: number; pid: number }
          | null;
        if (!res) {
          const spawnResult = (await pty.spawn(sessionId, cwd ?? '')) as
            | { ok: true; sid: string; pid: number; cols: number; rows: number }
            | { ok: false; error: string };
          if (!spawnResult || spawnResult.ok === false) {
            const reason =
              spawnResult && spawnResult.ok === false ? spawnResult.error : 'spawn_failed';
            throw new Error(reason);
          }
          res = (await pty.attach(sessionId)) as
            | { snapshot: string; cols: number; rows: number; pid: number }
            | null;
          if (!res) throw new Error('attach_failed_after_spawn');
        }
        // L4 PR-B (#865): we no longer use `res.snapshot`. The legacy
        // attach-time snapshot is a sync race with the live `pty:data`
        // fanout: by the time the IPC return value reaches the renderer,
        // additional chunks may have been broadcast that are NOT yet in
        // the snapshot, leading to either lost data or duplicated bytes
        // depending on which we wrote first. The new flow is:
        //   1. attach     → registers our webContents in the entry's
        //                   `attached` map (server now broadcasts to us).
        //   2. subscribe  → install a `pty.onData` listener that BUFFERS
        //                   chunks for this sid (seq tagged) instead of
        //                   writing them to the visible terminal.
        //   3. snapshot   → call `pty.getBufferSnapshot(sid)`, which
        //                   captures `(serialize(), entry.seq)` ATOMICALLY
        //                   under the main process's single-threaded loop.
        //   4. write snap → flush the snapshot to the visible terminal.
        //   5. drain      → write any buffered chunks with `seq > snapSeq`
        //                   in arrival order; these are the live tail
        //                   that arrived between steps 2 and 3.
        //   6. flip       → switch the listener into "write directly"
        //                   mode for all subsequent chunks (still seq
        //                   filtered, defensively, since seq monotonic
        //                   from this point).
        // This eliminates the dependency on claude voluntarily repainting
        // its alt-screen after attach (#852 root cause: alt-screen
        // applications like claude's TUI don't repaint on terminal size
        // change unless input arrives, so the visible xterm sat half-
        // empty until the user typed something).
        const { cols, rows } = res;
        if (cancelled || requestedSidRef.current !== sessionId) return;

        setActiveSid(sessionId);
        const t2 = getTerm();
        if (t2) {
          // Resize visible xterm to PTY's actual size BEFORE writing the
          // snapshot so the cell grid matches the snapshot's dimensions
          // (avoids the alt-screen reflow blanks when the pre-existing
          // visible xterm was at a different size). The post-attach fit
          // below then resizes everything to the real container, with the
          // snapshot replay (PR-D #866) reflowing the visible buffer to
          // match — so the only invariant we need here is "visible matches
          // snapshot at write time".
          try {
            t2.resize(cols, rows);
          } catch {
            // resize is best-effort — proceed with snapshot write.
          }
        }

        // Step 2: install the listener BEFORE requesting the snapshot.
        // `snapSeq` starts as null ("snapshot not yet landed, buffer
        // everything") and flips to a number once snapshot resolves
        // ("write directly, but defensively filter by seq").
        let snapSeq: number | null = null;
        const buffered: Array<{ seq: number; chunk: string }> = [];
        setUnsubscribeData(
          pty.onData((payload: { sid: string; chunk: string; seq: number }) => {
            if (payload.sid !== getActiveSid()) return;
            if (snapSeq === null) {
              buffered.push({ seq: payload.seq, chunk: payload.chunk });
              return;
            }
            // Post-snapshot: drop anything seq <= snapSeq (already in
            // the snapshot we wrote) and write the rest live.
            if (payload.seq > snapSeq) {
              getTerm()?.write(payload.chunk);
            }
          }),
        );

        // Step 3: request the snapshot. Async so a multi-MB serialize
        // doesn't block; chunks may continue to arrive on `pty.onData`
        // during this await and are caught by the buffering listener.
        const snap = (await pty.getBufferSnapshot(sessionId)) as {
          snapshot: string;
          seq: number;
        };
        if (cancelled || requestedSidRef.current !== sessionId) return;

        // Step 4: write snapshot to the visible terminal.
        const tSnap = getTerm();
        if (tSnap && snap.snapshot) tSnap.write(snap.snapshot);

        // Step 5: drain buffered chunks with seq > snapSeq, in order.
        // Anything with seq <= snapSeq is already represented in the
        // snapshot and would duplicate.
        snapSeq = snap.seq;
        const tDrain = getTerm();
        if (tDrain) {
          for (const b of buffered) {
            if (b.seq > snapSeq) tDrain.write(b.chunk);
          }
        }
        buffered.length = 0;

        // L4 PR-D (#866): install the snapshot-replay handler used by
        // `useTerminalResize` after a SIGWINCH. The handler re-runs
        // steps 2-5 against the now-reflowed headless buffer:
        //   1. flip back into "buffer everything" mode (snapSeq = null)
        //      so live chunks arriving DURING the replay are captured,
        //      not double-written
        //   2. fetch a fresh `(snapshot, seq)` from the headless mirror
        //      (which xterm's `Terminal.resize` has already reflowed)
        //   3. clear the visible xterm and write the snapshot — this
        //      replaces the now-stale pre-resize content with the
        //      reflowed cell grid, so the user sees correct wrapping
        //      WITHOUT depending on claude voluntarily repainting
        //      (claude is alt-screen and won't repaint on SIGWINCH)
        //   4. flip back into "write directly" mode and drain any
        //      chunks buffered during steps 2-3 with seq > snapSeq
        //
        // Closures over `snapSeq` and `buffered` keep the dedupe state
        // consistent with the listener installed at attach time — the
        // listener always reads `snapSeq` lazily so flipping it back
        // to null re-engages buffering.
        setSnapshotReplay(async () => {
          if (cancelled || requestedSidRef.current !== sessionId) return;
          // Re-engage buffering — listener checks `snapSeq === null`.
          snapSeq = null;
          let snap2: { snapshot: string; seq: number };
          try {
            snap2 = (await pty.getBufferSnapshot(sessionId)) as {
              snapshot: string;
              seq: number;
            };
          } catch (e) {
            console.warn('[TerminalPane] resize snapshot failed', e);
            // Re-arm so the listener resumes writing live chunks even
            // if the snapshot fetch failed — better stale grid than
            // permanent buffer-stall.
            snapSeq = 0;
            return;
          }
          if (cancelled || requestedSidRef.current !== sessionId) return;
          const tReplay = getTerm();
          if (tReplay) {
            try {
              tReplay.reset();
            } catch (e) {
              console.warn('[TerminalPane] resize reset failed', e);
            }
            if (snap2.snapshot) tReplay.write(snap2.snapshot);
          }
          snapSeq = snap2.seq;
          const tDrain2 = getTerm();
          if (tDrain2) {
            for (const b of buffered) {
              if (b.seq > snapSeq) tDrain2.write(b.chunk);
            }
          }
          buffered.length = 0;
        });

        const t3 = getTerm();
        if (t3) {
          setInputDisposable(
            t3.onData((data: string) => {
              const sid = getActiveSid();
              if (sid) window.ccsmPty.input(sid, data);
            }),
          );
        }

        // L4 PR-F (#867): post-attach, push the container size to the
        // backend so the PTY + headless source-of-truth buffer reflow to
        // the visible viewport (rather than staying at the spawn-time
        // 120x30). After the backend resize settles, run the snapshot
        // replay (PR-D #866) so the visible xterm rewrites from the
        // freshly-reflowed headless buffer — this replaces the old
        // pre-spawn measurement hack: the divergence between PTY size
        // and visible size is now resolved AFTER the fact by the
        // headless mirror, so claude doesn't need to voluntarily
        // repaint its alt-screen for the user to see correct content.
        const fit = getFit();
        const t4 = getTerm();
        const sid4 = getActiveSid();
        if (fit && t4 && sid4) {
          try {
            fit.fit();
            const resizePromise = window.ccsmPty.resize(sid4, t4.cols, t4.rows);
            const p = resizePromise && typeof (resizePromise as Promise<void>).then === 'function'
              ? (resizePromise as Promise<void>)
              : Promise.resolve();
            void p
              .then(() => {
                const replay = getSnapshotReplay();
                return replay ? replay() : undefined;
              })
              .catch((e) => console.warn('[TerminalPane] post-attach replay failed', e));
          } catch (e) {
            console.warn('[TerminalPane] post-attach fit failed', e);
          }
        }

        // Task #548 — transfer keyboard focus to the embedded xterm so the
        // user's first keystroke after spawning / importing / resuming a
        // session reaches claude's TUI rather than whichever sidebar
        // button or shortcut element triggered the create. App.tsx blurs
        // the trigger synchronously, but with no explicit handoff the
        // body becomes the activeElement and Enter ends up as a no-op.
        // Calling term.focus() here covers all entry paths (sidebar
        // click, keyboard shortcut, import, reopen-resume) because they
        // all funnel through this attach effect.
        const t5 = getTerm();
        if (t5) {
          try {
            t5.focus();
          } catch (e) {
            console.warn('[TerminalPane] term.focus failed', e);
          }
        }

        if (!cancelled) setState({ kind: 'ready' });
        // Successful (re-)attach means whatever pty is running for this
        // sid is healthy — drop any stale disconnect entry so the
        // sidebar red dot clears and a future crash starts from a clean
        // slate. Idempotent if no entry exists.
        clearPtyExitRef.current(sessionId);
      } catch (err) {
        if (cancelled || requestedSidRef.current !== sessionId) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
      // L4 PR-E (#864): explicit detach on unmount / sid change.
      // Symmetric with the `pty.attach` we issued above; without this
      // the entry's `attached` Map keeps a stale wc reference until
      // the renderer is destroyed (only the `wc.once('destroyed')`
      // handler in ipcRegistrar fires on full teardown). Stale entries
      // are tolerated by `dispatchPtyChunk` (it isDestroyed-checks
      // every send), but explicitly detaching here:
      //   1. keeps `entry.attached.size` honest so the PR-E
      //      backpressure-warn suppression activates as intended,
      //   2. makes the detach/reattach lifecycle visible in tests,
      //   3. lets a future "background sessions" UI accurately
      //      report which sessions have a live viewer.
      // No PTY data is lost: dispatchPtyChunk still writes to the
      // headless mirror unconditionally, and a subsequent re-attach
      // (initial mount, sid switch back, or Retry) replays via
      // `getBufferSnapshot` + drain (PR-B contract).
      const ptyApi = window.ccsmPty;
      if (ptyApi) {
        try {
          // Fire-and-forget: detach is idempotent on main; we don't
          // await because the React cleanup runs synchronously.
          void ptyApi.detach(sessionId);
        } catch {
          // best-effort — main may be tearing down.
        }
      }
    };
    // attachNonce is intentional: bumping it re-runs the attach for Retry.
  }, [sessionId, attachNonce, cwd]);

  // pty:exit subscription for the active session → flip to exit state with
  // a classification (clean vs crashed) shared with the store via
  // `classifyPtyExit` (src/lib/ptyExitClassifier.ts), so the active-pane
  // overlay and the sidebar red-dot signal stay consistent.
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
        setState({ kind: 'exit', exitKind, detail });
      },
    );
    return () => {
      try {
        unsubscribe?.();
      } catch {
        // already torn down — safe to ignore.
      }
    };
  }, []);

  const onRetry = useCallback(() => {
    setAttachNonce((n) => n + 1);
  }, []);

  return { state, onRetry };
}
