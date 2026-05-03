// Flash sink — single-responsibility executor that, given a Decision from
// `notifyDecider.decide`, records a transient `flash` signal for the
// affected sid in an in-memory map (mirrored onto globalThis for e2e probes).
//
// Wave 0c (#217): the renderer-IPC half (`webContents.send('notify:flash', ...)`)
// is removed. Wave 0d will let the daemon push this signal over its RPC
// channel; until then the sink is in-process bookkeeping only — AgentIcon
// in the renderer no longer receives flash events from the shell.
//
// Why a separate sink (vs. piggybacking on the existing 'session:state' IPC):
//   * The existing state stream is sourced from the JSONL watcher and runs
//     on its own clock; flash is a pipeline-driven "user-visible attention"
//     signal that may or may not coincide with a state transition.
//   * The 7 rules say flash even for muted sids (Rule 7). A muted sid
//     stays at `state === 'idle'` from the watcher's perspective; the only
//     way to surface attention there is a separate flash signal.
//   * Rule 2 (foreground + active + short) wants a halo without a toast;
//     reusing the watcher state to drive that would either re-trigger the
//     toast pipeline or require a new code path inside the watcher.
//
// Auto-clear: a flash is transient — we set `flashStates[sid] = true`,
// then schedule a clear after FLASH_DURATION_MS so the in-memory map doesn't
// grow unbounded. Repeated flashes reset the timer (debounce-style).

import type { BrowserWindow } from 'electron';
import type { Decision } from '../notifyDecider';

// 4s is long enough for a user to notice on return-to-window after a short
// task, short enough that an unattended flash doesn't leave the icon
// flickering forever. Tuned by feel — adjust if dogfood reveals issues.
export const FLASH_DURATION_MS = 4_000;

export interface FlashSinkOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Override duration for tests. Defaults to FLASH_DURATION_MS. */
  durationMs?: number;
}

export interface FlashSink {
  apply(decision: Decision): void;
  /** Clear the timer for `sid` (used on session teardown). */
  forget(sid: string): void;
  /** Tear down ALL pending timers and clear the flash map. Used on pipeline
   *  dispose / app shutdown so we don't leak `setTimeout` handles or hold
   *  closures over the sink internals past its useful lifetime. Safe to call
   *  multiple times. After dispose, `apply` still works on the in-memory map
   *  but no IPC sends will fire because the BrowserWindow is being torn down
   *  alongside this sink — we rely on the existing `isDestroyed()` guards. */
  dispose(): void;
  /** Test-only: returns the current in-memory flash map. */
  _peek(): Record<string, boolean>;
}

export function createFlashSink(opts: FlashSinkOptions): FlashSink {
  const dur = opts.durationMs ?? FLASH_DURATION_MS;
  const timers = new Map<string, NodeJS.Timeout>();
  const flashStates: Record<string, boolean> = {};

  // Test seam — mirror the in-memory flash map onto globalThis so e2e
  // probes can read it via `electronApp.evaluate(() => globalThis.__ccsmFlashStates)`
  // without an extra IPC round-trip. Keep this enabled unconditionally —
  // the cost is a single object reference and probe seams must be reliable.
  (globalThis as unknown as { __ccsmFlashStates?: Record<string, boolean> }).__ccsmFlashStates =
    flashStates;

  function send(_sid: string, _on: boolean): void {
    // Wave 0c (#217): renderer 'notify:flash' IPC removed. Flash state
    // remains tracked in `flashStates` (mirrored to globalThis for e2e
    // probes) so the in-process pipeline + tests still observe it; the
    // renderer no longer receives push events. Wave 0d will route this
    // through the daemon RPC channel.
    void opts.getMainWindow; // keep deps referenced for the future wire-up
  }

  function clear(sid: string): void {
    const t = timers.get(sid);
    if (t) {
      clearTimeout(t);
      timers.delete(sid);
    }
    if (flashStates[sid]) {
      delete flashStates[sid];
      send(sid, false);
    }
  }

  return {
    apply(decision) {
      if (!decision || !decision.flash) return;
      const sid = decision.sid;
      // Reset existing timer so a re-flash resets the visible duration.
      const existing = timers.get(sid);
      if (existing) clearTimeout(existing);
      const wasOn = flashStates[sid] === true;
      flashStates[sid] = true;
      if (!wasOn) send(sid, true);
      const t = setTimeout(() => clear(sid), dur);
      // Don't keep the event loop alive just for a UI flash.
      if (typeof t.unref === 'function') t.unref();
      timers.set(sid, t);
    },
    forget(sid) {
      clear(sid);
    },
    dispose() {
      // Snapshot first — `clear()` mutates `timers` and `flashStates`.
      const sids = Array.from(timers.keys());
      for (const sid of sids) clear(sid);
      // Belt-and-braces: clear any flashStates entries that somehow have no
      // timer (shouldn't happen, but cheap to guarantee). Send on=false so
      // the renderer mirror clears too.
      for (const sid of Object.keys(flashStates)) {
        if (flashStates[sid]) {
          delete flashStates[sid];
          send(sid, false);
        }
      }
    },
    _peek() {
      return { ...flashStates };
    },
  };
}
