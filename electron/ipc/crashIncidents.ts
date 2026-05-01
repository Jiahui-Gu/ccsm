// electron/ipc/crashIncidents.ts
//
// Phase 4 crash observability (spec §8, plan phase 4: send-last-crash).
//
// IPC surface:
//   - `crash:get-last-incident`  → { id, ts, surface, alreadySent } | null
//   - `crash:send-last-incident` → { ok: true; eventId? } | { ok: false; reason }
//
// Re-uploads the most recent incident dir (under the OS-specific crash root
// resolved by `electron/crash/incident-dir.ts`) to Sentry via the
// already-initialised main-process SDK from phase 2/3. Disable conditions:
//
//   - no incident on disk
//   - already-sent marker (`<incident>/.uploaded`) present
//   - Sentry was not initialised this run (consent != 'opted-in' OR DSN empty)
//
// We DO NOT re-route DSN selection — the existing main-proc Sentry init
// owns the routing; this module only triggers `captureMessage` + attachment
// upload, then writes the `.uploaded` marker on success.

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { fromMainFrame } from '../security/ipcGuards';
import { resolveCrashRoot } from '../crash/incident-dir';
import { isCrashUploadAllowed } from '../prefs/crashConsent';

export interface IncidentSummary {
  id: string;
  dirName: string;
  ts: string;
  surface: string;
  alreadySent: boolean;
}

const UPLOADED_MARKER = '.uploaded';

function listIncidents(crashRoot: string): { name: string; mtime: number }[] {
  try {
    return fs
      .readdirSync(crashRoot)
      .filter((n) => !n.startsWith('_') && !n.startsWith('.'))
      .map((n) => {
        const full = path.join(crashRoot, n);
        try {
          const stat = fs.statSync(full);
          if (!stat.isDirectory()) return null;
          return { name: n, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function readMeta(dir: string): { incidentId?: string; ts?: string; surface?: string } {
  try {
    const raw = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as { incidentId?: string; ts?: string; surface?: string };
    return parsed;
  } catch {
    return {};
  }
}

/** Pure helper exported for tests. Returns the most recent incident summary
 *  or null when the crash root is empty / unreadable. */
export function getLastIncidentSummary(crashRoot: string): IncidentSummary | null {
  const entries = listIncidents(crashRoot);
  const top = entries[0];
  if (!top) return null;
  const dir = path.join(crashRoot, top.name);
  const meta = readMeta(dir);
  const alreadySent = fs.existsSync(path.join(dir, UPLOADED_MARKER));
  return {
    id: meta.incidentId ?? top.name,
    dirName: top.name,
    ts: meta.ts ?? new Date(top.mtime).toISOString(),
    surface: meta.surface ?? 'unknown',
    alreadySent,
  };
}

interface SendResult {
  ok: boolean;
  eventId?: string;
  reason?: string;
}

interface SentryShim {
  captureMessage: (
    msg: string,
    hint?: { attachments?: Array<{ filename: string; data: Buffer | string; contentType?: string }> }
  ) => string | undefined;
  flush: (timeoutMs?: number) => Promise<boolean>;
}

const realSentry: SentryShim = Sentry as unknown as SentryShim;

/** Pure helper exported for tests. Re-uploads the given incident dir via
 *  Sentry's `captureMessage` + attachment hook. Writes the `.uploaded`
 *  marker on success. The `sentry` parameter is a test seam; production
 *  callers omit it and get the real `@sentry/electron/main` namespace. */
export async function sendIncident(
  dir: string,
  sentry: SentryShim = realSentry
): Promise<SendResult> {
  if (!fs.existsSync(dir)) return { ok: false, reason: 'incident-not-found' };
  if (fs.existsSync(path.join(dir, UPLOADED_MARKER))) {
    return { ok: false, reason: 'already-sent' };
  }
  if (!isCrashUploadAllowed()) {
    return { ok: false, reason: 'consent-not-granted' };
  }

  // Collect attachments from the incident dir. Skip the .uploaded marker
  // (doesn't exist yet) and anything that fails to read.
  const attachments: Array<{ filename: string; data: Buffer; contentType?: string }> = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === UPLOADED_MARKER) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        // Cap any single attachment at 1 MB so we don't blow the Sentry
        // envelope size. Crashpad dmps are usually well under this.
        if (stat.size > 1024 * 1024) continue;
        attachments.push({ filename: name, data: fs.readFileSync(full) });
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    return { ok: false, reason: 'incident-read-failed' };
  }

  let eventId: string | undefined;
  try {
    eventId = sentry.captureMessage(`crash incident replay`, { attachments });
    await sentry.flush(5000);
  } catch (err) {
    return { ok: false, reason: `sentry-error: ${(err as Error).message}` };
  }

  // Mark the incident as uploaded so the user can't double-send.
  try {
    fs.writeFileSync(
      path.join(dir, UPLOADED_MARKER),
      JSON.stringify({ ts: new Date().toISOString(), eventId: eventId ?? null }, null, 2),
      'utf8'
    );
  } catch {
    // Marker write failed; the upload still succeeded so we report ok.
  }
  return { ok: true, eventId };
}

export interface CrashIncidentsIpcDeps {
  ipcMain: IpcMain;
  /** Override for tests; defaults to resolveCrashRoot(). */
  crashRoot?: string;
}

export function registerCrashIncidentsIpc(deps: CrashIncidentsIpcDeps): void {
  const crashRoot = deps.crashRoot ?? resolveCrashRoot();
  deps.ipcMain.handle('crash:get-last-incident', (e: IpcMainInvokeEvent) => {
    if (!fromMainFrame(e)) return null;
    return getLastIncidentSummary(crashRoot);
  });
  deps.ipcMain.handle('crash:send-last-incident', async (e: IpcMainInvokeEvent) => {
    if (!fromMainFrame(e)) return { ok: false, reason: 'guard-rejected' };
    const summary = getLastIncidentSummary(crashRoot);
    if (!summary) return { ok: false, reason: 'incident-not-found' };
    return sendIncident(path.join(crashRoot, summary.dirName));
  });
}
