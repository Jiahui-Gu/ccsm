// JSONL record formatting + per-file header for the main-process logger.

import * as fs from 'node:fs';
import * as os from 'node:os';
import { getApp, type LogLevel } from './logRuntime';
import { LOG_SCHEMA_VERSION } from './logState';

/** Per-file header written as the FIRST line of every new (or rotated) log
 *  file. Makes attached logs self-describing — no need to ask the user
 *  "what version were you on". */
export function buildHeader(currentLevel: LogLevel): string {
  let appVersion = 'unknown';
  try {
    appVersion = getApp()?.getVersion?.() ?? 'unknown';
  } catch {
    /* app not ready in tests */
  }
  return (
    JSON.stringify({
      schemaV: LOG_SCHEMA_VERSION,
      app: 'ccsm',
      version: appVersion,
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      os: process.platform,
      arch: process.arch,
      level: currentLevel,
      sessionStart: new Date().toISOString(),
    }) + os.EOL
  );
}

/** Write the header to the live file if it's empty (fresh boot or
 *  immediately post-rotation). electron-log's `archiveLog` hook fires AFTER
 *  the rotation; this function is idempotent so calling it on every record
 *  costs at most one stat call (handled by the size check). */
export function ensureHeader(filePath: string, currentLevel: LogLevel): void {
  try {
    const st = fs.statSync(filePath);
    if (st.size === 0) {
      fs.writeFileSync(filePath, buildHeader(currentLevel), { flag: 'a' });
    }
  } catch {
    // file does not yet exist — electron-log will create it on first write
    // and we'll header it on the next call. No-op here.
  }
}

/** electron-log message formatter → JSONL. electron-log's transform chain
 *  treats `format` as `(params: FormatParams) => any[]`; we return a
 *  1-element array containing the JSONL string and the downstream `toString`
 *  transform serializes it as-is. We accept already-structured payloads from
 *  our `log.api.emit()` in `data[0]` and augment with timestamp/level;
 *  ad-hoc string args are wrapped. */
export function jsonlFormat(params: {
  data: unknown[];
  level: string;
  message: { date: Date };
}): unknown[] {
  const first = params.data[0];
  let payload: Record<string, unknown>;
  // Convention: every `emit()` / `log.event` call site stringifies a single
  // JSON object and passes it as `data[0]` (see `emit()` below — it always
  // calls `elog[level](JSON.stringify(record))` with no trailing newline and
  // no second arg). The `{…}` shape check is a fast structural filter that
  // distinguishes our structured records from ad-hoc string args (e.g.
  // direct `elog.warn('plain text')` from third-party paths). Any payload
  // that matches `{…}` is parse-and-merged; everything else is wrapped as
  // `{msg: ...}`. The `JSON.parse` is inside a try/catch so a stray `{json-
  // shaped} string` doesn't crash the transport.
  if (typeof first === 'string' && first.startsWith('{') && first.endsWith('}')) {
    try {
      payload = JSON.parse(first) as Record<string, unknown>;
    } catch {
      payload = { msg: first };
    }
  } else {
    payload = { msg: params.data.map((d) => String(d)).join(' ') };
  }
  const record = {
    t: params.message.date.toISOString(),
    level: params.level,
    pid: process.pid,
    ...payload,
  };
  return [JSON.stringify(record)];
}
