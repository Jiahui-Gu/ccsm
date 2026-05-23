import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { classifyPtyExit } from '../lib/ptyExitClassifier';
import { warn } from '../shared/log';
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
  writeAndScrollToBottom,
  writeOrBuffer,
} from './xtermSingleton';

// xterm's `Terminal.write()` is asynchronous: bytes are appended to an
// internal queue and processed on a parser tick, so synchronous code that
// runs immediately after a `write()` call (notably `scrollToBottom()`) can
// observe a stale `baseY`. The 2-arg form fires a callback after the chunk
// is flushed through the parser; wrap it as a promise so callers can await
// before reading viewport state. A 0-length string is a valid flush
// sentinel — xterm processes writes in order, so awaiting an empty write
// drains everything queued before it.
const writeAsync = (
  t: { write: (s: string, cb?: () => void) => void },
  s: string,
): Promise<void> => new Promise((resolve) => t.write(s, resolve));

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
  // Right-click "Reload session" — the slice action `reloadSession` kills
  // the pty and bumps this nonce, which we read here so the attach effect
  // re-runs and walks the spawn-on-null fallback for a fresh pty. Same
  // re-attach semantics as Retry, just with an external trigger.
  const reloadNonce = useStore((s) => s.reloadNonce?.[sessionId] ?? 0);

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
          | { cols: number; rows: number; pid: number }
          | null;
        if (!res) {
          // Right-click "Copy session" → `copySession` registers the source
          // sid in `pendingForkSource[newSid]`. Read it BEFORE we hand off
          // to the spawn IPC; main turns it into `--resume <src>
          // --fork-session --session-id <new>` so the new pty boots with
          // the source's transcript context. Pass `undefined` for the
          // common (non-fork) path so `pty.spawn`'s 3rd arg stays absent
          // over the wire (matches the pre-fork IPC shape exactly when no
          // copy is in flight).
          const forkSourceSid =
            useStore.getState().pendingForkSource[sessionId] ?? undefined;
          const spawnResult = (await pty.spawn(sessionId, cwd ?? '', forkSourceSid)) as
            | { ok: true; sid: string; pid: number; cols: number; rows: number }
            | { ok: false; error: string };
          // Clear the fork marker regardless of spawn outcome. On success
          // the JSONL now exists, so any subsequent re-spawn (Retry, new
          // session row mount) takes the normal `--resume` branch in
          // `entryFactory`. On failure we don't want to re-fire `--fork-
          // session` against a CLI that just rejected it — Retry should
          // attempt a clean `--session-id` spawn so the user isn't stuck
          // in a fork loop.
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
        // L4 PR-B (#865) + #888 follow-up: the visible-buffer paint is driven
        // by `getBufferSnapshot` below. The legacy attach-time snapshot
        // field has been removed entirely from AttachResult (it was always
        // discarded here and the main-process serialize was a wasted
        // multi-K-line call on every attach). Flow remains:
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
              writeOrBuffer(payload.chunk);
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
        if (tSnap && snap.snapshot) await writeAsync(tSnap, snap.snapshot);

        // Step 5: drain buffered chunks with seq > snapSeq, in order.
        // Anything with seq <= snapSeq is already represented in the
        // snapshot and would duplicate.
        snapSeq = snap.seq;
        const tDrain = getTerm();
        if (tDrain) {
          for (const b of buffered) {
            if (b.seq > snapSeq) tDrain.write(b.chunk);
          }
          // Flush the xterm write queue before reading viewport state.
          // `write` is async; without this the scrollToBottom below races
          // a not-yet-processed write and observes a stale baseY.
          await writeAsync(tDrain, '');
        }
        buffered.length = 0;

        // Attach-time invariant: end at bottom. xterm normally follows live
        // output, but a `term.reset()` + `term.write(snapshot)` sequence
        // does NOT guarantee viewportY ends at baseY (a wheel event landing
        // in the middle of the snapshot write, or a scrollback truncation
        // when the snapshot exceeds the configured cap, leaves the viewport
        // stranded). Pin it explicitly — the user's mental model on session
        // attach is "I'm caught up at the prompt". This runs AFTER the
        // writeAsync above has flushed the parser queue, so baseY reflects
        // the snapshot+drain content.
        const tAfterSnap = getTerm();
        if (tAfterSnap) {
          try {
            tAfterSnap.scrollToBottom();
          } catch {
            // best-effort — scroll API rarely fails, ignore.
          }
        }

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
        //
        // Concurrency: two replay drivers exist — the post-attach fit
        // gate below, and the ResizeObserver in `useTerminalResize`.
        // They can fire close in time (post-attach gate + a layout
        // settle that triggers the RO). Letting both run concurrently
        // means two `reset()` + `write(snapshot)` pairs interleave;
        // the second `reset()` can land mid-write of the first replay,
        // and the visible viewport ends stranded (typically at the top
        // — the user's "attach lands at scroll top" report). Coalesce
        // overlapping calls: if a replay is in flight, mark a pending
        // bit and return; the in-flight replay re-runs once more after
        // it finishes. Only the latest snapshot matters — older
        // pending requests are subsumed by the next fetch.
        let replayInFlight = false;
        let replayPending = false;
        const runReplay = async (): Promise<void> => {
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
            warn('attach', 'resize snapshot failed', e);
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
              warn('attach', 'resize reset failed', e);
            }
            if (snap2.snapshot) await writeAsync(tReplay, snap2.snapshot);
          }
          snapSeq = snap2.seq;
          const tDrain2 = getTerm();
          if (tDrain2) {
            for (const b of buffered) {
              if (b.seq > snapSeq) tDrain2.write(b.chunk);
            }
            // Flush the parser queue so the scrollToBottom below sees the
            // post-replay baseY, not a stale pre-write one. xterm processes
            // writes in order; awaiting a 0-length write drains everything
            // queued before it.
            await writeAsync(tDrain2, '');
          }
          buffered.length = 0;
          // Once we've awaited the snapshot write + drain through xterm's
          // queue, the visible buffer is rewritten from scratch. xterm's
          // default "follow live output" is not re-engaged by `write`
          // alone if the user-scroll latch was set, and `reset()` doesn't
          // clear that latch reliably either. Pin viewport to bottom so
          // the user sees the prompt — same invariant as the attach-time
          // snapshot write above.
          const tBottom = getTerm();
          if (tBottom) {
            try {
              tBottom.scrollToBottom();
            } catch {
              // best-effort.
            }
          }
        };
        setSnapshotReplay(async () => {
          if (replayInFlight) {
            replayPending = true;
            return;
          }
          replayInFlight = true;
          try {
            await runReplay();
            // Drain any request that arrived while we were running.
            // Loop (not a single re-run) because a third request could
            // arrive during the drain run.
            while (replayPending && !cancelled && requestedSidRef.current === sessionId) {
              replayPending = false;
              await runReplay();
            }
          } finally {
            replayInFlight = false;
            replayPending = false;
          }
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
            // Gate the post-attach resize+replay on a REAL backend-resize
            // need (#888 + follow-up). The previous gate compared post-fit
            // term dims against PRE-fit term dims — but those pre-fit dims
            // had just been overwritten to the PTY spawn size by the
            // `t2.resize(cols, rows)` above, so the gate almost always saw
            // a delta and fired a redundant `pty.resize` + snapshot replay
            // (an extra main-process serialize + a `term.reset()` + full
            // re-write of the visible buffer — the dominant attach cost on
            // sessions with multi-K-line scrollback).
            //
            // The correct question is: does the container size match the
            // current PTY size? After `fit.fit()` the term dims reflect the
            // container; if those equal the PTY's `cols/rows` no backend
            // resize is needed and we can skip the replay too. STRICT gate:
            // only skip on exact match — the replay path still fires on
            // real deltas (the #852 alt-screen-blank case).
            fit.fit();
            const newCols = t4.cols;
            const newRows = t4.rows;
            if (newCols !== cols || newRows !== rows) {
              const resizePromise = window.ccsmPty.resize(sid4, newCols, newRows);
              const p = resizePromise && typeof (resizePromise as Promise<void>).then === 'function'
                ? (resizePromise as Promise<void>)
                : Promise.resolve();
              void p
                .then(() => {
                  const replay = getSnapshotReplay();
                  return replay ? replay() : undefined;
                })
                .then(() => {
                  // Post-attach fit branch: even though the replay
                  // handler itself scrolls to bottom after its drain,
                  // we re-assert here as a defensive rendezvous. The
                  // replay queues writes against the live xterm and
                  // its internal scroll happens once THAT WriteBuffer
                  // drains; an unrelated chunk that landed between the
                  // fit and the replay (e.g. claude reacting to the
                  // resize) could otherwise leave baseY advanced past
                  // viewportY again. Cheap empty-write rendezvous.
                  const tFit = getTerm();
                  if (tFit) writeAndScrollToBottom(tFit);
                })
                .catch((e) => warn('attach', 'post-attach replay failed', e));
            }
          } catch (e) {
            warn('attach', 'post-attach fit failed', e);
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
            warn('attach', 'term.focus failed', e);
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
    // reloadNonce is intentional: bumping it (via `reloadSession` after a
    // pty.kill) re-runs the attach so the spawn-on-null fallback brings
    // up a fresh pty for the same sid (env / config refresh).
  }, [sessionId, attachNonce, reloadNonce, cwd]);

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
