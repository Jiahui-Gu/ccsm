// electron/ipc/rendererErrorForwarder.ts
//
// Phase 5 crash observability — renderer-side error forwarder.
//
// The renderer installs window.onerror + window.onunhandledrejection (and
// optionally console.error in dev builds) hooks that invoke this IPC. The
// main process then routes the report through the phase-1 collector, which
// writes a `surface: 'renderer'` incident under the standard crash root and
// (when the phase-2/3 Sentry SDK is initialised + phase-4 consent allows)
// forwards it to the renderer DSN.
//
// We don't open a separate Sentry init path here. The existing main-process
// Sentry SDK (electron/sentry/init.ts) already auto-routes events from any
// surface; @sentry/electron/renderer reports flow through the IPC bridge it
// installs, but those only fire when the renderer SDK is actually imported.
// This forwarder is the on-disk + main-routed safety net for crashes that
// escape the renderer SDK or happen before its init runs.
//
// Hard constraints (phase 4 territory, NOT changed here):
//   - local incident write happens regardless of consent state.
//   - Sentry upload is gated by isCrashUploadAllowed() inside Sentry init.
//
// Rate-limiting: ≤ N events per W ms per renderer process (webContents.id),
// to prevent a tight `console.error` loop from filling the disk. Excess
// events are silently dropped; the dropped count is folded into the next
// accepted incident's stderr-tail breadcrumb so we don't lose the signal.

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { fromMainFrame } from '../security/ipcGuards';
import type { CrashCollector, SerializedError } from '../crash/collector';
import { redactSecrets } from '../crash/scrub';

export interface RendererErrorReport {
  error: SerializedError;
  /** 'window.onerror' | 'window.onunhandledrejection' | 'console.error' */
  source: string;
  /** Optional renderer-supplied breadcrumb (URL/path the error came from). */
  url?: string;
}

export interface RendererErrorRateLimiter {
  /** Returns true when the event is allowed; false when it was rate-limited. */
  tryAcquire(processId: number): boolean;
  /** How many events were silently dropped for this processId since the last
   *  accepted event. Reading this value also resets it (one-shot drain). */
  drainDroppedCount(processId: number): number;
  /** Read-only peek for tests + diagnostics. */
  getDroppedCount(processId: number): number;
}

interface RateLimiterOpts { windowMs: number; max: number }

/** Sliding-window rate limiter. One bucket per renderer process. */
export function createRendererErrorRateLimiter(opts: RateLimiterOpts): RendererErrorRateLimiter {
  const stamps = new Map<number, number[]>();
  const dropped = new Map<number, number>();

  function pruneWindow(arr: number[], now: number): number[] {
    const cutoff = now - opts.windowMs;
    let i = 0;
    while (i < arr.length && arr[i]! < cutoff) i++;
    return i === 0 ? arr : arr.slice(i);
  }

  return {
    tryAcquire(processId: number): boolean {
      const now = Date.now();
      const arr = pruneWindow(stamps.get(processId) ?? [], now);
      if (arr.length >= opts.max) {
        stamps.set(processId, arr);
        dropped.set(processId, (dropped.get(processId) ?? 0) + 1);
        return false;
      }
      arr.push(now);
      stamps.set(processId, arr);
      return true;
    },
    drainDroppedCount(processId: number): number {
      const n = dropped.get(processId) ?? 0;
      if (n > 0) dropped.set(processId, 0);
      return n;
    },
    getDroppedCount(processId: number): number {
      return dropped.get(processId) ?? 0;
    },
  };
}

export interface HandleDeps {
  collector: CrashCollector;
  limiter: RendererErrorRateLimiter;
  processId: number;
}

export interface HandleResult { accepted: boolean; reason?: string }

/** Pure handler used by the IPC wiring + tests. Records a renderer-surface
 *  incident through the phase-1 collector and includes any drop-count
 *  breadcrumb for events that were rate-limited since the last acceptance. */
export function handleRendererErrorReport(report: RendererErrorReport, deps: HandleDeps): HandleResult {
  const { collector, limiter, processId } = deps;
  if (!limiter.tryAcquire(processId)) {
    return { accepted: false, reason: 'rate-limited' };
  }
  const drops = limiter.drainDroppedCount(processId);
  const breadcrumbs: string[] = [];
  breadcrumbs.push(`renderer-error source=${report.source}`);
  if (report.url) breadcrumbs.push(`renderer-error url=${report.url}`);
  if (drops > 0) breadcrumbs.push(`renderer-error-drops=${drops}`);

  collector.recordIncident({
    surface: 'renderer',
    // Redact secrets at the main-side trust boundary (frag-6-7 §6.6.3).
    // We do this in main rather than in renderer so a compromised renderer
    // can't bypass scrubbing by skipping the call. The collector also runs
    // scrubHomePath on top of these strings.
    error: {
      name: report.error.name,
      message: redactSecrets(report.error.message),
      stack: report.error.stack ? redactSecrets(report.error.stack) : undefined,
    },
    stderrTail: breadcrumbs.map(b => redactSecrets(b)),
  });
  return { accepted: true };
}

export interface RegisterRendererErrorIpcDeps {
  ipcMain: IpcMain;
  collector: CrashCollector;
  /** Override for tests; defaults to a 10-event / 60-second sliding window. */
  limiter?: RendererErrorRateLimiter;
}

const CHANNEL = 'crash:report-renderer-error';

export function registerRendererErrorForwarderIpc(deps: RegisterRendererErrorIpcDeps): void {
  const limiter = deps.limiter ?? createRendererErrorRateLimiter({ windowMs: 60_000, max: 10 });
  deps.ipcMain.handle(CHANNEL, (e: IpcMainInvokeEvent, report: RendererErrorReport) => {
    if (!fromMainFrame(e)) return { accepted: false, reason: 'guard-rejected' };
    if (!report || typeof report !== 'object' || !report.error || typeof report.error.message !== 'string') {
      return { accepted: false, reason: 'malformed' };
    }
    return handleRendererErrorReport(report, {
      collector: deps.collector,
      limiter,
      processId: e.sender.id,
    });
  });
}

export const RENDERER_ERROR_IPC_CHANNEL = CHANNEL;
