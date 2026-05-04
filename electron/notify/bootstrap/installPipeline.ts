// Notify pipeline construction + producer wiring. Extracted from
// electron/main.ts (Task #742 Phase B/C).
//
// The pipeline is the single toast producer (PR #689 Phase C):
//   producer  : ptyHost.onData → OscTitleSniffer (#688)
//   decider   : notifyDecider.decide(event, ctx) (#687)
//   sinks     : toastSink (Electron Notification) + flashSink (renderer push)
//
// This module owns the `installNotifyPipeline` call + the focus/blur,
// PTY-data, and unwatched-session producer subscriptions. The badge/tray
// fan-out and renderer-IPC fan-in stay in main.ts (the badge manager + the
// register*Ipc callbacks need a stable reference back to main's mutable
// state — pipeline lifetime is shorter than main's).

import { app, BrowserWindow } from 'electron';
import { installNotifyPipeline } from '../sinks/pipeline';
import { onPtyData } from '../../../packages/daemon/src/ptyHost';
import { sessionWatcher } from '../../sessionWatcher';
import { forgetSid as forgetSessionTitleSid } from '../../sessionTitles';

export type NotifyPipeline = ReturnType<typeof installNotifyPipeline>;

/** Bundle returned by `installNotifyPipelineWithProducers`. The `pipeline`
 *  is the live pipeline (passed through to fan-out modules). The `dispose`
 *  hook detaches every producer subscription this module registered (app
 *  focus/blur listeners + sessionWatcher 'unwatched' listener) AND tears
 *  down the pipeline itself (sniffer + flash timers). Call from
 *  `app.before-quit` to avoid HMR / test leaks (audit #876 cluster 3.8 /
 *  Task #884). */
export interface InstalledNotifyPipeline {
  pipeline: NotifyPipeline;
  dispose: () => void;
}

export interface NotifyPipelineDeps {
  /** Look up the user-visible name for a sid so toasts can label with the
   *  rename / SDK auto-summary instead of the bare UUID. */
  getNameFn: (sid: string) => string | null;
  /** True when global notifications are muted via Settings. */
  isGlobalMutedFn: () => boolean;
  /** Side-effect when a notification fires (badge bump). */
  onNotified: (sid: string) => void;
  /** Side-effect when a session is unwatched (PTY exit / kill).
   *  Used to drain badge unread counts so deleted/torn-down sessions
   *  don't leave stale entries that inflate the aggregate badge total
   *  forever (audit #876 H2). Optional for tests that don't care. */
  onUnwatchedSid?: (sid: string) => void;
}

/** Construct the pipeline and wire the producer subscriptions. Returns the
 *  live pipeline so main.ts can fan its `setActiveSid` / `markUserInput`
 *  signals from the renderer-IPC layer, plus a `dispose` to detach every
 *  listener registered here. */
export function installNotifyPipelineWithProducers(
  deps: NotifyPipelineDeps,
): InstalledNotifyPipeline {
  const pipelineInstance = installNotifyPipeline({
    getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    isGlobalMutedFn: deps.isGlobalMutedFn,
    getNameFn: deps.getNameFn,
    onNotified: deps.onNotified,
  });

  // Wire OSC sniffer producer: every PTY chunk feeds the sniffer.
  onPtyData((sid, chunk) => {
    pipelineInstance.feedChunk(sid, chunk);
  });

  // Focus/blur producer: the decider needs `ctx.focused` to differentiate
  // foreground (Rules 2/3/4) from background (Rule 5). Subscribe at the app
  // level so we cover both windows being created later and existing ones.
  const onFocus = (): void => {
    pipelineInstance.setFocused(true);
  };
  const onBlur = (): void => {
    // browser-window-blur fires per-window. With only one BrowserWindow this
    // is equivalent to "ccsm is no longer focused"; if multi-window lands
    // we'd need to count instead. Until then, treat blur as defocus.
    const anyFocused = BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isFocused(),
    );
    pipelineInstance.setFocused(anyFocused);
  };
  app.on('browser-window-focus', onFocus);
  app.on('browser-window-blur', onBlur);

  // Drop sniffer/ctx state when a session is unwatched (PTY exit). The
  // existing 'unwatched' emitter is reused so we don't add another teardown
  // path. Also release the per-sid Maps held by sessionTitles (titleCache /
  // opChains / pendingRenames) — without this, every sid ever queried for a
  // title sticks in memory for the lifetime of the app (audit #876, H1).
  // Finally, fan out to `onUnwatchedSid` so callers (main.ts) can drain
  // their own per-sid stores — e.g. badgeManager.unread, which would
  // otherwise inflate the aggregate badge total forever (audit #876 H2).
  const onUnwatched = (evt: { sid?: unknown }): void => {
    if (!evt || typeof evt.sid !== 'string' || evt.sid.length === 0) return;
    pipelineInstance.forgetSid(evt.sid);
    forgetSessionTitleSid(evt.sid);
    deps.onUnwatchedSid?.(evt.sid);
  };
  sessionWatcher.on('unwatched', onUnwatched);

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Detach producer listeners so app shutdown / HMR re-install doesn't
    // leak listener references back into the lifecycle (audit #876 cluster
    // 3.8 / Task #884). `app.off` and `EventEmitter.off` are idempotent on
    // unknown handlers, but we tracked the exact references so we don't
    // accidentally remove someone else's subscription either.
    try {
      app.off('browser-window-focus', onFocus);
      app.off('browser-window-blur', onBlur);
    } catch {
      /* ignore — best-effort on shutdown */
    }
    try {
      sessionWatcher.off('unwatched', onUnwatched);
    } catch {
      /* ignore — best-effort on shutdown */
    }
    // Tear down sniffer subscriptions + flash timers.
    try {
      pipelineInstance.dispose();
    } catch {
      /* ignore — best-effort on shutdown */
    }
  }

  return { pipeline: pipelineInstance, dispose };
}
