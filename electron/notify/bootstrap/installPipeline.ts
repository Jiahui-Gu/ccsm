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
import { onPtyData } from '../../ptyHost';
import { sessionWatcher } from '../../sessionWatcher';

export type NotifyPipeline = ReturnType<typeof installNotifyPipeline>;

export interface NotifyPipelineDeps {
  /** Look up the user-visible name for a sid so toasts can label with the
   *  rename / SDK auto-summary instead of the bare UUID. */
  getNameFn: (sid: string) => string | null;
  /** True when global notifications are muted via Settings. */
  isGlobalMutedFn: () => boolean;
  /** Side-effect when a notification fires (badge bump). */
  onNotified: (sid: string) => void;
}

/** Construct the pipeline and wire the producer subscriptions. Returns the
 *  live pipeline so main.ts can fan its `setActiveSid` / `markUserInput`
 *  signals from the renderer-IPC layer. */
export function installNotifyPipelineWithProducers(
  deps: NotifyPipelineDeps,
): NotifyPipeline {
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
  app.on('browser-window-focus', () => {
    pipelineInstance.setFocused(true);
  });
  app.on('browser-window-blur', () => {
    // browser-window-blur fires per-window. With only one BrowserWindow this
    // is equivalent to "ccsm is no longer focused"; if multi-window lands
    // we'd need to count instead. Until then, treat blur as defocus.
    const anyFocused = BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isFocused(),
    );
    pipelineInstance.setFocused(anyFocused);
  });

  // Drop sniffer/ctx state when a session is unwatched (PTY exit). The
  // existing 'unwatched' emitter is reused so we don't add another teardown
  // path.
  sessionWatcher.on('unwatched', (evt: { sid?: unknown }) => {
    if (!evt || typeof evt.sid !== 'string' || evt.sid.length === 0) return;
    pipelineInstance.forgetSid(evt.sid);
  });

  return pipelineInstance;
}
