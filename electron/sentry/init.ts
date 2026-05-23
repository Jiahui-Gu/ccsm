// Sentry init wrapper. Extracted from electron/main.ts (Task #730 Phase A1).
//
// Crash reporting is OFF by default unless the operator plugs in a DSN
// via `SENTRY_DSN` at launch time. We intentionally do NOT ship a hardcoded
// project DSN in the open-source repo: self-hosters would otherwise send
// crashes to the maintainer's Sentry project with no opt-in. If you are
// building a fork, pass `SENTRY_DSN=https://...@your-project` to the app.
//
// `beforeSend` consults the user's opt-out preference at every send so the
// Settings toggle takes effect immediately (the cache is invalidated by the
// `db:save` IPC handler in main.ts when the renderer writes the key).
//
// PR B Stage 2 hardening (observability-design-v2 §3):
//  * `defaultIntegrations: false` — `@sentry/electron/main` defaults pull in
//    the entire Node SDK default set (httpIntegration, consoleIntegration,
//    onUnhandledRejectionIntegration, electronBreadcrumbsIntegration with
//    webContents/browserWindow event capture, etc). Several of those grab
//    URLs, console arguments, and IPC payloads verbatim — pre-scrub. We
//    strip the lot and only add back `electronMinidumpIntegration()` so
//    native crash dumps still ship.
//  * `sendDefaultPii: false` ONLY controls IP / cookies / user-id
//    inference; it does NOT cover HTTP bodies, console args, or DOM events.
//    Those leak via the default integration set — hence the `false` above.
//  * `beforeSend` and `beforeBreadcrumb` both run the shared scrubber over
//    every string-bearing field (`message`, `exception.values[].value`,
//    stacktrace frame paths, `extra`, `contexts`, `tags`, `request`,
//    `crumb.message`, `crumb.data`). Forbidden field names → dropped;
//    paths → `[path]`; connection strings → `[connection-string]`;
//    env-secret keys → `[redacted]`. Recursive, depth-capped.
//  * `release: ccsm@<version>` — reads from `app.getVersion()`, which in
//    a packaged build is the version from `package.json`. Prefix matches
//    the design doc's `ccsm@${packageJson.version}` format so Sentry's
//    "version" facet groups correctly across SDK/platform shards.

import * as Sentry from '@sentry/electron/main';
import { electronMinidumpIntegration } from '@sentry/electron/main';
import { app } from 'electron';
import { loadCrashReportingOptOut } from '../prefs/crashReporting';
import { scrub } from '../../src/shared/scrub';

/**
 * Scrub a Sentry event in place. Every string-valued field that could carry
 * user content or paths is rewritten via the shared scrubber. We walk:
 *   * `event.message`
 *   * `event.exception.values[*].value` + `stacktrace.frames[*].filename / module / abs_path / function`
 *   * `event.breadcrumbs[*]` (handled separately by `beforeBreadcrumb` for live crumbs;
 *     scrubbed here too defensively in case the event arrives with frozen crumbs attached)
 *   * `event.extra`, `event.contexts`, `event.tags`, `event.request`
 *
 * Implementation: lean on `scrub()` for objects (forbidden-field drop +
 * env-key redaction + path/conn-string rewriting on every leaf string).
 * Stack-frame filename/module fields use `scrub(string)` directly because
 * those are top-level string slots that the recursive scrubber would
 * normally only reach via parent-object traversal.
 */
type AnyRecord = Record<string, unknown>;

function scrubSentryEvent(event: AnyRecord): AnyRecord | null {
  try {
    if (typeof event.message === 'string') {
      event.message = scrub(event.message) as string;
    }
    const ex = event.exception as
      | { values?: Array<AnyRecord> }
      | undefined;
    if (ex?.values) {
      for (const v of ex.values) {
        if (typeof v.value === 'string') v.value = scrub(v.value) as string;
        if (typeof v.type === 'string') v.type = scrub(v.type) as string;
        const st = v.stacktrace as { frames?: Array<AnyRecord> } | undefined;
        if (st?.frames) {
          for (const f of st.frames) {
            for (const k of ['filename', 'abs_path', 'module', 'function'] as const) {
              if (typeof f[k] === 'string') f[k] = scrub(f[k] as string) as string;
            }
          }
        }
      }
    }
    for (const k of ['extra', 'contexts', 'tags', 'request', 'user'] as const) {
      if (event[k] != null && typeof event[k] === 'object') {
        event[k] = scrub(event[k]);
      }
    }
    const crumbs = event.breadcrumbs as Array<AnyRecord> | undefined;
    if (Array.isArray(crumbs)) {
      event.breadcrumbs = crumbs
        .map((c) => scrubBreadcrumb(c))
        .filter((c): c is AnyRecord => c != null);
    }
  } catch {
    // Logging must never crash the host. If scrub itself throws, the safer
    // failure mode is to drop the event entirely.
    return null;
  }
  return event;
}

/**
 * Scrub a Sentry breadcrumb. Returns `null` to drop the crumb when post-scrub
 * it's effectively empty (every meaningful field was a forbidden-field that
 * got removed). Drop-on-empty matters because Sentry's default breadcrumb
 * shapes (`{category, message, data}`) become useless when `message` AND all
 * of `data`'s keys are forbidden — better to drop than ship a structurally-
 * valid but information-free entry that still leaks the category timing.
 */
function scrubBreadcrumb(crumb: AnyRecord): AnyRecord | null {
  try {
    if (typeof crumb.message === 'string') {
      crumb.message = scrub(crumb.message) as string;
    }
    if (crumb.data != null && typeof crumb.data === 'object') {
      crumb.data = scrub(crumb.data);
    }
    // Drop the crumb when it carries no message AND no surviving data fields.
    const hasMsg = typeof crumb.message === 'string' && crumb.message.length > 0;
    const dataObj = crumb.data as AnyRecord | null | undefined;
    const hasData = dataObj != null && Object.keys(dataObj).length > 0;
    if (!hasMsg && !hasData) return null;
  } catch {
    return null;
  }
  return crumb;
}

// Exported for unit tests.
export { scrubSentryEvent, scrubBreadcrumb };

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim() || undefined;
  if (!dsn) {
    console.info('[sentry] SENTRY_DSN not set — crash reporting disabled.');
    return;
  }
  Sentry.init({
    dsn,
    release: `ccsm@${app.getVersion()}`,
    environment: app.isPackaged ? 'prod' : 'dev',
    sendDefaultPii: false,
    // Strip the default integration set entirely. See the file-level comment
    // for the rationale: the Node SDK defaults capture HTTP URLs, console
    // arguments, and Electron IPC payloads pre-scrub.
    defaultIntegrations: false,
    integrations: [
      // Native crash dumps via Electron's built-in minidump uploader. No
      // application-level data captured; this just ships the crash file.
      electronMinidumpIntegration(),
    ],
    beforeSend(event) {
      try {
        const optOut = loadCrashReportingOptOut();
        if (optOut) return null;
      } catch {
        /* fall through, send anyway */
      }
      return scrubSentryEvent(event as unknown as AnyRecord) as unknown as typeof event;
    },
    beforeBreadcrumb(crumb) {
      return scrubBreadcrumb(crumb as unknown as AnyRecord) as unknown as typeof crumb;
    },
  });
}
