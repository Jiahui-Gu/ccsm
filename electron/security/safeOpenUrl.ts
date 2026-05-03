// Scheme-allowlisted wrapper around Electron's `shell.openExternal` (Task #72,
// T6.9 — spec: docs/superpowers/specs/2026-05-03-v03-daemon-split
// /ch08-electron-renderer.md §9).
//
// `shell.openExternal` will happily hand a `file://`, `javascript:`, or
// arbitrary custom-scheme URL straight to the OS-registered protocol handler,
// which on every desktop platform is a code-execution primitive in disguise:
//
//   - `file://`     → opens local files / shares (UNC-style on Windows leaks
//                     NTLM creds to attacker-chosen hosts; on macOS/Linux
//                     reveals files the user never intended to expose).
//   - `javascript:` → silently dropped by Chromium today, but historical
//                     regressions have re-enabled it; not worth trusting.
//   - custom (`vscode:`, `slack:`, `ms-cxh:`, ...) → triggers whatever the
//                     user has registered, often with attacker-controlled
//                     command-line arguments.
//
// All renderer-supplied URLs MUST flow through `safeOpenUrl`. Direct
// `shell.openExternal(...)` calls in `electron/**` are forbidden — see the
// repo lint check in CI.
//
// The allowlist is deliberately tight: only `http:` and `https:`. If a future
// feature legitimately needs another scheme (e.g. `mailto:` from a help link)
// it should be added here with a code comment explaining why, not bypassed at
// the call site.

import { shell } from 'electron';

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export class UnsafeUrlError extends Error {
  readonly url: string;
  readonly scheme: string | null;
  constructor(url: string, scheme: string | null, reason: string) {
    super(`safeOpenUrl: refusing to open ${url} (${reason})`);
    this.name = 'UnsafeUrlError';
    this.url = url;
    this.scheme = scheme;
  }
}

// Pure decider: does this URL string belong to the allowlist? Exposed for
// unit tests and for callers that want to validate-without-opening (e.g. to
// gray out a "Open in browser" menu item before the user clicks).
export function isSafeUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return ALLOWED_SCHEMES.has(parsed.protocol);
}

// Sink: validate, then delegate to `shell.openExternal`. Throws
// `UnsafeUrlError` synchronously on a rejected URL so callers can surface the
// failure (toast, logger, telemetry) rather than silently dropping the click.
//
// Returns the same `Promise<void>` as `shell.openExternal` so callers that
// `await` it for sequencing keep working.
export async function safeOpenUrl(raw: unknown): Promise<void> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UnsafeUrlError(String(raw), null, 'not a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeUrlError(raw, null, 'not a parseable URL');
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new UnsafeUrlError(raw, parsed.protocol, `scheme ${parsed.protocol} not in allowlist`);
  }
  await shell.openExternal(raw);
}
