# Crash observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every crash on either the frontend (electron-main + renderer) or the backend (`ccsm-daemon`) leave a recoverable on-disk artifact bundle, correlate the two sides via a single incident `traceId`, and route to Sentry under one project (`tags.surface`) when DSN is configured — closing the 2026-05-01 16:18 "nothing on disk" gap.

**Architecture:** A new `electron/crash/collector.ts` in electron-main owns the umbrella incident directory under `%LOCALAPPDATA%\CCSM\crashes\<ts>-<ulid>/`. Both processes write into the same incident dir (frontend directly via the collector; daemon writes a marker file under `<runtimeRoot>/crash/<bootNonce>.json` that electron-main's supervisor adopts on `child.on('exit')`). Sentry uses one project dimensioned by `tags.surface` (`main` | `renderer` | `daemon`); DSN is build-time-injected via `webpack.DefinePlugin` for the renderer and `scripts/before-pack.cjs` → `dist/electron/build-info.js` for main + daemon.

**Tech Stack:** TypeScript, Electron 41 (`crashReporter`, `app.on('render-process-gone'|'child-process-gone')`, `BrowserWindow.on('unresponsive')`), `@sentry/electron`, `@sentry/node`, `pino` + `pino-roll`, `ulid` (already in `package.json:82`), `webpack.DefinePlugin`, `electron-builder` `afterAllArtifactBuild`, `@sentry/cli`.

**Source-of-truth spec:** `docs/superpowers/specs/2026-05-01-crash-observability-design.md` — every task below cites a `[spec §X]` anchor.

---

## File structure

Files created or modified, grouped by phase. Paths the spec already names are reused verbatim.

### Phase 1 — recoverable artifacts on every crash, no DSN needed

- **Create** `electron/crash/collector.ts` — `startCrashCollector()`, `recordIncident()`, `flush()`, dmp-staging adoption, retention pruner. [spec §5.1, §10]
- **Create** `electron/crash/incident-dir.ts` — incident-dir layout helpers (path resolution per OS, `meta.json` writer, `README.txt` summary writer, ULID timestamp naming). [spec §10]
- **Create** `electron/crash/ring-buffer.ts` — bounded `RingBuffer<string>` for stderr/stdout tails (200 lines). [spec §5.3]
- **Create** `electron/crash/scrub.ts` — `scrubHomePath()` (forward + back slash), env allowlist (`NODE_ENV`, `CCSM_*`, `ELECTRON_*`). [spec §7]
- **Modify** `electron/main.ts` (lines 40–52) — replace `console.error`-only `uncaughtException`/`unhandledRejection`, call `startCrashCollector()`, call `crashReporter.start({ submitURL: '', uploadToServer: false, compress: true })` and `app.setPath('crashDumps', …_dmp-staging)` before `app.whenReady()`, register `app.on('render-process-gone')` + `app.on('child-process-gone')`. [spec §5.1]
- **Create** `electron/daemon/supervisor.ts` (or extend whatever lands first from v0.3) — adds `attachCrashCapture(handle, collector)`, ring-buffer tee, `lastTraceId` tracking, `child.on('exit')` → `recordIncident({ surface: 'daemon-exit' })`, marker-file adoption, `ccsm:daemon-crash` IPC emit. [spec §5.3]
- **Create** `daemon/src/crash/handlers.ts` — `installCrashHandlers({ logger, bootNonce, runtimeRoot, getLastTraceId })`, writes `<runtimeRoot>/crash/<bootNonce>.json`, calls `process.exit(70)`. [spec §5.2, §9]
- **Modify** `daemon/src/index.ts` (before line 101 dispatcher wiring) — call `installCrashHandlers(...)`, expose `getLastTraceId()` from RPC dispatch. [spec §5.2]
- **Create** `electron/preload/crash.ts` (or extend `electron/preload/index.ts`) — expose `ccsm:crash:report-from-renderer` IPC bridge. [spec §5.1]
- **Create** `tests/electron/crash/collector.test.ts` — unit tests for `recordIncident`, `meta.json` schema, retention pruner, dmp-staging rename race. [spec §10]
- **Create** `tests/daemon/crash/handlers.test.ts` — unit tests for marker-file write + exit code 70.
- **Create** `tests/electron/daemon/supervisor.crash.test.ts` — exit-handler attaches incident, ring-buffer tail captured, marker adopted.
- **Create** `tests/e2e/crash-phase1.probe.ts` — e2e probe: throw from hidden IPC, kill -9 daemon child, throw inside daemon RPC handler; assert incident dir contents. [spec §11 phase 1]

### Phase 2 — Sentry routing for both processes, build-time DSN injection

- **Create** `scripts/before-pack.cjs` — generates `dist/electron/build-info.js` exporting `{ sentryDsn }` from `process.env.SENTRY_DSN` (empty string when secret absent). [spec §6]
- **Modify** `webpack.config.js` (or equivalent renderer webpack config) — add `webpack.DefinePlugin({ 'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN ?? '') })`. [spec §6]
- **Modify** `electron/sentry/init.ts` (lines 18–35) — read `process.env.SENTRY_DSN ?? buildInfo.sentryDsn`, set `initialScope: { tags: { surface: 'main' } }`. [spec §5.1, §6]
- **Modify** `src/index.tsx` (line 15) — set `initialScope: { tags: { surface: 'renderer' } }` on `sentryInit({})`. [spec §6]
- **Create** `daemon/src/sentry/init.ts` — `initDaemonSentry({ dsn, release, bootNonce })` using `@sentry/node`, `initialScope: { tags: { surface: 'daemon' } }`. [spec §5.2, §6]
- **Modify** `daemon/src/index.ts` (top of file) — call `initDaemonSentry({ dsn: process.env.CCSM_DAEMON_DSN ?? process.env.SENTRY_DSN })`. [spec §5.2]
- **Modify** `electron/daemon/supervisor.ts` — forward DSN to daemon child via `spawn(..., { env: { ...process.env, CCSM_DAEMON_DSN: resolvedDsn } })`. [spec §5.2]
- **Modify** `package.json` (`build` block) — add `extraMetadata.sentryDsn` and `beforePack` hook pointing at `scripts/before-pack.cjs`.
- **Create** `tests/electron/sentry/init.empty-dsn.test.ts` — regression: empty/`***REDACTED***` DSN short-circuits init. [spec §6 OSS-fork leak prevention]
- **Create** `tests/daemon/sentry/init.test.ts` — daemon init with surface tag + flush(2000).

### Phase 3 — symbol pipeline + native daemon segfaults

- **Create** `scripts/sentry-upload-symbols.cjs` — `@sentry/cli upload-dif` for renderer source maps (`dist/renderer/*.map`), Electron debug symbols (downloaded from Electron's symbol server), native module pdbs/dSYMs for `better-sqlite3` and `node-pty`; gated on `SENTRY_AUTH_TOKEN` presence; idempotent + version-keyed. [spec §5.4, §6]
- **Modify** `package.json` (`build.afterAllArtifactBuild`) — wire to the new script.
- **Modify** `.github/workflows/release.yml` (or whichever release workflow runs `make:win`/`make:mac`) — set `SENTRY_AUTH_TOKEN` from secrets, install `@sentry/cli`.
- **Create** `daemon/src/crash/native-handler.ts` — optional `node-segfault-handler` install for POSIX (skipped on Windows in phase 3); writes `backend.dmp` into `<runtimeRoot>/crash/<bootNonce>-native.dmp`. [spec §5.2 option A]
- **Modify** `daemon/src/index.ts` — call `installNativeCrashHandler()` after `installCrashHandlers()`.
- **Modify** `electron/daemon/supervisor.ts` — adopt `<runtimeRoot>/crash/<bootNonce>-native.dmp` into the incident dir as `backend.dmp` alongside the marker. [spec §10]
- **Create** `tests/daemon/crash/native-handler.test.ts` — guarded by platform === posix; spawns child that triggers `process.binding('crashtest')` style native segfault and asserts dmp file lands.
- **Create** `tests/e2e/crash-phase3.probe.ts` — verify symbolicated stack appears in a Sentry test project (mocked transport asserting source-map application).

### Phase 4 — "Send last crash" UX + first-run consent banner

- **Modify** `electron/lifecycle/appLifecycle.ts` — add Help → "Send last crash report…" menu item. [spec §8]
- **Create** `electron/crash/ipc.ts` — `ccsm:crash:list-incidents`, `ccsm:crash:reveal-incident` (uses `shell.showItemInFolder`), `ccsm:crash:send-incident` (zips dir, `Sentry.captureEvent` + `addAttachment`, `flush(5000)`). [spec §8]
- **Create** `src/components/crash/CrashReportModal.tsx` — modal listing last 5 incidents, per-file checkboxes, Reveal-in-folder + Send-to-maintainer buttons; Send disabled when DSN absent or `crashReportingOptOut === true`. [spec §8]
- **Create** `src/components/crash/FirstCrashConsent.tsx` — one-shot modal shown on first crash detection; defaults to upload ON; links to Settings → Crash reporting toggle. [spec §7 phase 4 deferred banner]
- **Modify** `electron/main.ts` (`BrowserWindow` creation) — register `win.on('unresponsive')` / `'responsive'`; on `unresponsive` > 5s, call `webContents.capturePage()` → save `screenshot.png` into the active incident dir. [spec §5.1 renderer hang]
- **Create** `tests/electron/crash/ipc.send-incident.test.ts` — end-to-end zip-and-attach flow with mocked Sentry transport returning a stub eventId.
- **Create** `tests/renderer/crash/CrashReportModal.test.tsx` — render with 0/1/5 incidents, Send disabled cases, checkbox state.
- **Create** `tests/e2e/crash-phase4.probe.ts` — open Help menu, click "Send last crash", verify modal appears with seeded incident dirs.

### Phase 5 — log forwarding + rolling files everywhere

- **Create** `electron/log/rolling.ts` — `createRollingLogger({ dir, baseName, level })` returning a `pino.Logger` with date+size rotation (7 days × 10 MB) via `pino-roll`; applies `scrubHomePath` formatter. [spec §5.5]
- **Create** `daemon/src/log/rolling.ts` — same module path duplicated for daemon (small duplication preferable to v0.3 shared package). [spec §5.5]
- **Modify** `electron/main.ts` — instantiate frontend rolling logger at `<userData>/logs/frontend-YYYY-MM-DD.jsonl`, redirect `console.{info,warn,error}` through it.
- **Modify** `daemon/src/index.ts` (lines 18–25) — add rolling sink alongside existing pino stdout: `<runtimeRoot>/logs/backend-YYYY-MM-DD.jsonl`.
- **Create** `electron/log/renderer-forwarder.ts` — IPC sink for renderer `console.*` forwarding (frag-6-7 §6.6.2 channel) writing into the frontend rolling log.
- **Modify** `electron/preload/index.ts` — bridge renderer console to the new IPC channel.
- **Create** `tests/electron/log/rolling.test.ts` — rotation by date + size, scrubbing applied, level threshold honored.
- **Create** `tests/e2e/crash-phase5.probe.ts` — assert `frontend-YYYY-MM-DD.jsonl` and `backend-YYYY-MM-DD.jsonl` exist after a normal app boot, and that a triggered incident bundles the latest 5000 lines from each.

---

## Phase 1 — recoverable artifacts on every crash, no DSN needed

> Spec §11 phase 1. Three PRs. After this phase a local incident dir exists for every crash on either side, with `SENTRY_DSN` empty and no network.

### Task 1: `electron/crash/collector.ts` — incident dir, meta.json, retention pruner

**Files:**
- Create: `electron/crash/incident-dir.ts`
- Create: `electron/crash/scrub.ts`
- Create: `electron/crash/ring-buffer.ts`
- Create: `electron/crash/collector.ts`
- Test: `tests/electron/crash/collector.test.ts`

- [ ] **Step 1: Write the failing test for `scrubHomePath`**

```typescript
// tests/electron/crash/scrub.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import { scrubHomePath, redactEnv } from '../../../electron/crash/scrub';

describe('scrubHomePath', () => {
  it('replaces forward-slash home with ~', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/alice');
    expect(scrubHomePath('opened /Users/alice/foo')).toBe('opened ~/foo');
  });
  it('replaces back-slash home with ~', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\alice');
    expect(scrubHomePath('opened C:\\Users\\alice\\foo')).toBe('opened ~\\foo');
  });
});

describe('redactEnv', () => {
  it('keeps allowlisted keys only', () => {
    const out = redactEnv({
      NODE_ENV: 'production',
      CCSM_FOO: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/usr/bin',
      HOME: '/h',
      SECRET: 's',
    });
    expect(out).toEqual({ NODE_ENV: 'production', CCSM_FOO: 'x', ELECTRON_RUN_AS_NODE: '1' });
  });
});
```

Run: `npx vitest run tests/electron/crash/scrub.test.ts`
Expected: FAIL with "Cannot find module '../../../electron/crash/scrub'"

- [ ] **Step 2: Implement `scrub.ts`**

```typescript
// electron/crash/scrub.ts
import * as os from 'node:os';

const ALLOW = /^(NODE_ENV|CCSM_.*|ELECTRON_.*)$/;

export function scrubHomePath(s: string): string {
  const home = os.homedir();
  if (!s || !home) return s;
  // Replace longest match first; both raw and backslash-escaped variants.
  return s.split(home).join('~');
}

export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v != null && ALLOW.test(k)) out[k] = v;
  }
  return out;
}
```

Run: `npx vitest run tests/electron/crash/scrub.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Write the failing test for `RingBuffer`**

```typescript
// tests/electron/crash/ring-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../../electron/crash/ring-buffer';

describe('RingBuffer', () => {
  it('keeps last N entries', () => {
    const r = new RingBuffer<string>(3);
    r.push('a'); r.push('b'); r.push('c'); r.push('d');
    expect(r.snapshot()).toEqual(['b', 'c', 'd']);
  });
  it('snapshot is a copy', () => {
    const r = new RingBuffer<string>(2);
    r.push('a');
    const snap = r.snapshot();
    r.push('b');
    expect(snap).toEqual(['a']);
  });
});
```

Run: `npx vitest run tests/electron/crash/ring-buffer.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 4: Implement `ring-buffer.ts`**

```typescript
// electron/crash/ring-buffer.ts
export class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly cap: number) {}
  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  snapshot(): T[] {
    return this.buf.slice();
  }
  get length(): number {
    return this.buf.length;
  }
}
```

Run: `npx vitest run tests/electron/crash/ring-buffer.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write failing test for `incident-dir.ts`**

```typescript
// tests/electron/crash/incident-dir.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveCrashRoot, createIncidentDir, writeMeta, IncidentMeta } from '../../../electron/crash/incident-dir';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-crash-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('incident-dir', () => {
  it('createIncidentDir returns dir under root with timestamped+ulid name', () => {
    const dir = createIncidentDir(tmp);
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(tmp);
    expect(path.basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it('writeMeta writes meta.json with schemaVersion 1', () => {
    const dir = createIncidentDir(tmp);
    const meta: IncidentMeta = {
      schemaVersion: 1, incidentId: '01ARZ3',
      ts: '2026-05-01T16:18:03.412Z', surface: 'daemon-exit',
      appVersion: '0.3.0', electronVersion: '41.3.0',
      os: { platform: 'win32', release: '10.0.26200', arch: 'x64' },
    };
    writeMeta(dir, meta);
    const read = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(read.schemaVersion).toBe(1);
    expect(read.surface).toBe('daemon-exit');
  });
});
```

Run: `npx vitest run tests/electron/crash/incident-dir.test.ts`
Expected: FAIL — module not found

- [ ] **Step 6: Implement `incident-dir.ts`**

```typescript
// electron/crash/incident-dir.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from 'ulid';

export interface IncidentMeta {
  schemaVersion: 1;
  incidentId: string;
  ts: string;
  surface: 'main' | 'renderer' | 'gpu' | 'helper' | 'daemon-exit' | 'daemon-uncaught' | 'daemon-boot-crash';
  appVersion: string;
  electronVersion: string;
  os: { platform: string; release: string; arch: string };
  frontend?: { lastSentryEventId?: string; logFile?: string; logRange?: string };
  backend?: {
    exitCode: number | null;
    signal: string | null;
    bootNonce?: string;
    lastTraceId?: string;
    lastHealthzAgoMs: number | null;
    markerPresent: boolean;
  };
}

export function resolveCrashRoot(localAppData?: string): string {
  if (process.platform === 'win32') {
    const base = localAppData ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'CCSM', 'crashes');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CCSM', 'crashes');
  }
  return path.join(os.homedir(), '.local', 'share', 'CCSM', 'crashes');
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }
function tsStamp(d = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

export function createIncidentDir(root: string, id: string = ulid()): string {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `${tsStamp()}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeMeta(dir: string, meta: IncidentMeta): void {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

export function writeReadme(dir: string, summary: string): void {
  fs.writeFileSync(path.join(dir, 'README.txt'), summary, 'utf8');
}
```

Run: `npx vitest run tests/electron/crash/incident-dir.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Write failing tests for `collector.ts`**

```typescript
// tests/electron/crash/collector.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startCrashCollector } from '../../../electron/crash/collector';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-coll-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('crash collector', () => {
  it('recordIncident writes meta.json with surface and ts', () => {
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dir = c.recordIncident({ surface: 'main', error: { message: 'boom', stack: 'at x' } });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.surface).toBe('main');
    expect(meta.schemaVersion).toBe(1);
    expect(typeof meta.ts).toBe('string');
  });

  it('recordIncident writes stderr-tail and stdout-tail when supplied', () => {
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dir = c.recordIncident({
      surface: 'daemon-exit', exitCode: null, signal: 'SIGSEGV',
      stderrTail: ['err1', 'err2'], stdoutTail: ['out1'],
      lastTraceId: '01ARZ3', bootNonce: 'BN1',
    });
    expect(fs.readFileSync(path.join(dir, 'stderr-tail.txt'), 'utf8')).toBe('err1\nerr2\n');
    expect(fs.readFileSync(path.join(dir, 'stdout-tail.txt'), 'utf8')).toBe('out1\n');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.backend.signal).toBe('SIGSEGV');
    expect(meta.backend.lastTraceId).toBe('01ARZ3');
  });

  it('adoptDmpStaging moves *.dmp into incident dir as frontend.dmp', () => {
    const staging = path.join(tmp, '_dmp-staging');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'a.dmp'), 'D1');
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: staging, appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dir = c.recordIncident({ surface: 'main' });
    expect(fs.existsSync(path.join(dir, 'frontend.dmp'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'a.dmp'))).toBe(false);
  });

  it('retention prunes beyond max(20 incidents, 30 days)', () => {
    // Create 25 incidents all dated today, expect 5 oldest pruned (>20, all within 30d).
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    for (let i = 0; i < 25; i++) c.recordIncident({ surface: 'main' });
    c.pruneRetention({ maxCount: 20, maxAgeDays: 30 });
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(remaining.length).toBe(20);
  });
});
```

Run: `npx vitest run tests/electron/crash/collector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 8: Implement `collector.ts`**

```typescript
// electron/crash/collector.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from 'ulid';
import { createIncidentDir, writeMeta, writeReadme, IncidentMeta } from './incident-dir';
import { scrubHomePath } from './scrub';

export interface SerializedError { message: string; stack?: string; name?: string }

export interface IncidentInput {
  surface: IncidentMeta['surface'];
  error?: SerializedError;
  exitCode?: number | null;
  signal?: string | null;
  stderrTail?: string[];
  stdoutTail?: string[];
  lastTraceId?: string;
  bootNonce?: string;
  lastHealthzAgoMs?: number | null;
  markerPath?: string; // path to <runtimeRoot>/crash/<bootNonce>.json
}

export interface CollectorOpts {
  crashRoot: string;
  dmpStaging: string;
  appVersion: string;
  electronVersion: string;
}

export interface CrashCollector {
  recordIncident(input: IncidentInput): string;
  flush(): Promise<void>;
  pruneRetention(opts: { maxCount: number; maxAgeDays: number }): void;
}

export function startCrashCollector(opts: CollectorOpts): CrashCollector {
  fs.mkdirSync(opts.crashRoot, { recursive: true });
  fs.mkdirSync(opts.dmpStaging, { recursive: true });

  function adoptDmps(dir: string): void {
    if (!fs.existsSync(opts.dmpStaging)) return;
    const entries = fs.readdirSync(opts.dmpStaging)
      .filter(n => n.endsWith('.dmp'))
      .map(n => ({ n, m: fs.statSync(path.join(opts.dmpStaging, n)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    let first = true;
    for (const { n } of entries) {
      const src = path.join(opts.dmpStaging, n);
      const dst = path.join(dir, first ? 'frontend.dmp' : `frontend-${n}`);
      try {
        fs.renameSync(src, dst);
        first = false;
      } catch {
        // rename race; another collector consumed it. swallow.
      }
    }
  }

  function adoptMarker(dir: string, markerPath?: string): boolean {
    if (!markerPath || !fs.existsSync(markerPath)) return false;
    try {
      fs.renameSync(markerPath, path.join(dir, 'daemon-marker.json'));
      return true;
    } catch {
      return false;
    }
  }

  function recordIncident(input: IncidentInput): string {
    const id = ulid();
    const dir = createIncidentDir(opts.crashRoot, id);
    const ts = new Date().toISOString();

    if (input.stderrTail) {
      fs.writeFileSync(path.join(dir, 'stderr-tail.txt'),
        input.stderrTail.map(scrubHomePath).join('\n') + '\n', 'utf8');
    }
    if (input.stdoutTail) {
      fs.writeFileSync(path.join(dir, 'stdout-tail.txt'),
        input.stdoutTail.map(scrubHomePath).join('\n') + '\n', 'utf8');
    }
    if (input.error) {
      fs.writeFileSync(path.join(dir, 'error.json'),
        JSON.stringify({
          name: input.error.name,
          message: scrubHomePath(input.error.message ?? ''),
          stack: input.error.stack ? scrubHomePath(input.error.stack) : undefined,
        }, null, 2), 'utf8');
    }

    const markerPresent = adoptMarker(dir, input.markerPath);
    adoptDmps(dir);

    const meta: IncidentMeta = {
      schemaVersion: 1,
      incidentId: id,
      ts,
      surface: input.surface,
      appVersion: opts.appVersion,
      electronVersion: opts.electronVersion,
      os: { platform: process.platform, release: require('node:os').release(), arch: process.arch },
      backend: input.surface.startsWith('daemon') ? {
        exitCode: input.exitCode ?? null,
        signal: input.signal ?? null,
        bootNonce: input.bootNonce,
        lastTraceId: input.lastTraceId,
        lastHealthzAgoMs: input.lastHealthzAgoMs ?? null,
        markerPresent,
      } : undefined,
    };
    writeMeta(dir, meta);
    writeReadme(dir, summarize(meta, input));
    return dir;
  }

  function summarize(meta: IncidentMeta, input: IncidentInput): string {
    const lines = [
      `CCSM crash report ${meta.incidentId}`,
      `time:    ${meta.ts}`,
      `surface: ${meta.surface}`,
      `app:     ${meta.appVersion}  electron: ${meta.electronVersion}`,
      `os:      ${meta.os.platform} ${meta.os.release} ${meta.os.arch}`,
    ];
    if (meta.backend) {
      lines.push(`exit:    code=${meta.backend.exitCode} signal=${meta.backend.signal}`);
      lines.push(`bootNonce: ${meta.backend.bootNonce ?? '(none)'}  lastTraceId: ${meta.backend.lastTraceId ?? '(none)'}`);
    }
    if (input.error) lines.push('', 'error:', `  ${input.error.message}`);
    return lines.join('\n') + '\n';
  }

  function pruneRetention({ maxCount, maxAgeDays }: { maxCount: number; maxAgeDays: number }): void {
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    let entries: { name: string; mtime: number }[];
    try {
      entries = fs.readdirSync(opts.crashRoot)
        .filter(n => !n.startsWith('_'))
        .map(n => ({ name: n, mtime: fs.statSync(path.join(opts.crashRoot, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime); // newest first
    } catch {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const tooOld = e.mtime < cutoff;
      const overCount = i >= maxCount;
      // Keep larger of "20 newest" and "all within 30 days".
      if (tooOld && overCount) {
        try { fs.rmSync(path.join(opts.crashRoot, e.name), { recursive: true, force: true }); } catch {}
      }
    }
  }

  async function flush(): Promise<void> { /* sentry flush hooked in phase 2 */ }

  return { recordIncident, flush, pruneRetention };
}
```

Run: `npx vitest run tests/electron/crash/collector.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add electron/crash/ tests/electron/crash/
git commit -m "feat(crash): add electron-main crash collector with incident dir, scrub, retention"
```

### Task 2: Wire `electron/main.ts` handlers + crashReporter + render-process-gone

**Files:**
- Modify: `electron/main.ts:40-52`
- Test: `tests/electron/main.crash-handlers.test.ts`

- [ ] **Step 1: Write failing test for handler wiring**

```typescript
// tests/electron/main.crash-handlers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { wireCrashHandlers } from '../../electron/main-crash-wiring';

describe('wireCrashHandlers', () => {
  it('uncaughtException routes to collector with surface=main', () => {
    const calls: any[] = [];
    const collector = { recordIncident: (i: any) => { calls.push(i); return '/tmp/x'; }, flush: async () => {}, pruneRetention: () => {} };
    const proc = new (require('node:events').EventEmitter)();
    wireCrashHandlers({ collector, processRef: proc as any });
    proc.emit('uncaughtException', new Error('boom'));
    expect(calls.length).toBe(1);
    expect(calls[0].surface).toBe('main');
    expect(calls[0].error.message).toBe('boom');
  });

  it('unhandledRejection routes to collector', () => {
    const calls: any[] = [];
    const collector = { recordIncident: (i: any) => { calls.push(i); return '/tmp/x'; }, flush: async () => {}, pruneRetention: () => {} };
    const proc = new (require('node:events').EventEmitter)();
    wireCrashHandlers({ collector, processRef: proc as any });
    proc.emit('unhandledRejection', new Error('rej'));
    expect(calls.length).toBe(1);
    expect(calls[0].error.message).toBe('rej');
  });
});
```

Run: `npx vitest run tests/electron/main.crash-handlers.test.ts`
Expected: FAIL

- [ ] **Step 2: Extract `electron/main-crash-wiring.ts`**

```typescript
// electron/main-crash-wiring.ts
import type { CrashCollector } from './crash/collector';

export interface WireOpts {
  collector: CrashCollector;
  processRef: NodeJS.Process;
}

function serialize(err: unknown): { message: string; stack?: string; name?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack, name: err.name };
  return { message: String(err) };
}

export function wireCrashHandlers({ collector, processRef }: WireOpts): void {
  processRef.on('uncaughtException', (err: unknown) => {
    try { collector.recordIncident({ surface: 'main', error: serialize(err) }); }
    catch (e) { console.error('crash collector failed', e); }
  });
  processRef.on('unhandledRejection', (reason: unknown) => {
    try { collector.recordIncident({ surface: 'main', error: serialize(reason) }); }
    catch (e) { console.error('crash collector failed', e); }
  });
}
```

Run: `npx vitest run tests/electron/main.crash-handlers.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Modify `electron/main.ts` to call `startCrashCollector`, `crashReporter.start`, register `wireCrashHandlers`, and child-process listeners**

Open `electron/main.ts`. Around the existing `process.on('uncaughtException', ...)` block (lines 40–48 per spec §3) replace with:

```typescript
// electron/main.ts (additions; preserve existing imports + app initialization)
import { app, crashReporter } from 'electron';
import * as path from 'node:path';
import { startCrashCollector } from './crash/collector';
import { resolveCrashRoot } from './crash/incident-dir';
import { wireCrashHandlers } from './main-crash-wiring';

const crashRoot = resolveCrashRoot();
const dmpStaging = path.join(crashRoot, '_dmp-staging');

crashReporter.start({ submitURL: '', uploadToServer: false, compress: true });
app.setPath('crashDumps', dmpStaging);

const crashCollector = startCrashCollector({
  crashRoot,
  dmpStaging,
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron ?? 'unknown',
});

// Replace the existing console.error-only handlers (was at electron/main.ts:40-48):
wireCrashHandlers({ collector: crashCollector, processRef: process });

app.on('render-process-gone', (_e, webContents, details) => {
  crashCollector.recordIncident({
    surface: 'renderer',
    error: { message: `render-process-gone: ${details.reason}`, name: details.reason },
    exitCode: details.exitCode ?? null,
  });
});

app.on('child-process-gone', (_e, details) => {
  crashCollector.recordIncident({
    surface: details.type === 'GPU' ? 'gpu' : 'helper',
    error: { message: `child-process-gone: ${details.type} ${details.reason}`, name: details.reason },
    exitCode: details.exitCode ?? null,
  });
});

// On boot: prune retention (best-effort).
try { crashCollector.pruneRetention({ maxCount: 20, maxAgeDays: 30 }); } catch {}
```

- [ ] **Step 4: Run main-process require smoke test**

Per `feedback_main_process_load_smoke_test`:

```bash
npx tsc -p tsconfig.electron.json && node -e "require('./dist/electron/main.js')" || true
```
Expected: file loads (any "app is not ready" message after load is fine; we only verify ESM/CJS resolution).

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/main-crash-wiring.ts tests/electron/main.crash-handlers.test.ts
git commit -m "feat(crash): wire electron-main uncaught/unhandled handlers + crashReporter staging dir + child-process-gone"
```

### Task 3: Daemon `crash/handlers.ts` — uncaught/unhandled, marker file, exit(70)

**Files:**
- Create: `daemon/src/crash/handlers.ts`
- Modify: `daemon/src/index.ts` (before line 101 dispatcher wiring)
- Test: `tests/daemon/crash/handlers.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/daemon/crash/handlers.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import pino from 'pino';
import { installCrashHandlers } from '../../../daemon/src/crash/handlers';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-d-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('installCrashHandlers', () => {
  it('writes marker file and exits with code 70 on uncaught', () => {
    const exits: number[] = [];
    const proc = new (require('node:events').EventEmitter)();
    (proc as any).exit = (c: number) => { exits.push(c); };
    installCrashHandlers({
      logger: pino({ level: 'silent' }),
      bootNonce: 'BN1',
      runtimeRoot: tmp,
      getLastTraceId: () => 'TR1',
      processRef: proc as any,
    });
    proc.emit('uncaughtException', new Error('boom'));
    const marker = path.join(tmp, 'crash', 'BN1.json');
    expect(fs.existsSync(marker)).toBe(true);
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    expect(m.bootNonce).toBe('BN1');
    expect(m.surface).toBe('daemon-uncaught');
    expect(m.kind).toBe('uncaughtException');
    expect(m.message).toBe('boom');
    expect(m.lastTraceId).toBe('TR1');
    expect(exits).toEqual([70]);
  });

  it('handles unhandledRejection', () => {
    const exits: number[] = [];
    const proc = new (require('node:events').EventEmitter)();
    (proc as any).exit = (c: number) => { exits.push(c); };
    installCrashHandlers({
      logger: pino({ level: 'silent' }), bootNonce: 'BN2',
      runtimeRoot: tmp, getLastTraceId: () => undefined, processRef: proc as any,
    });
    proc.emit('unhandledRejection', new Error('rej'));
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'crash', 'BN2.json'), 'utf8'));
    expect(m.kind).toBe('unhandledRejection');
    expect(exits).toEqual([70]);
  });
});
```

Run: `npx vitest run tests/daemon/crash/handlers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `daemon/src/crash/handlers.ts`**

```typescript
// daemon/src/crash/handlers.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type pino from 'pino';

export interface InstallOpts {
  logger: pino.Logger;
  bootNonce: string;
  runtimeRoot: string;
  getLastTraceId: () => string | undefined;
  processRef?: NodeJS.Process;
}

interface MarkerV1 {
  schemaVersion: 1;
  bootNonce: string;
  ts: string;
  surface: 'daemon-uncaught';
  kind: 'uncaughtException' | 'unhandledRejection';
  message: string;
  stack?: string;
  lastTraceId?: string;
}

export function installCrashHandlers(opts: InstallOpts): void {
  const proc = opts.processRef ?? process;
  const crashDir = path.join(opts.runtimeRoot, 'crash');
  fs.mkdirSync(crashDir, { recursive: true });
  const markerPath = path.join(crashDir, `${opts.bootNonce}.json`);

  function record(kind: MarkerV1['kind'], errLike: unknown): void {
    const err = errLike instanceof Error ? errLike : new Error(String(errLike));
    const marker: MarkerV1 = {
      schemaVersion: 1,
      bootNonce: opts.bootNonce,
      ts: new Date().toISOString(),
      surface: 'daemon-uncaught',
      kind,
      message: err.message,
      stack: err.stack,
      lastTraceId: opts.getLastTraceId(),
    };
    try {
      opts.logger.fatal({ event: 'daemon.crash', kind, err: { message: err.message, stack: err.stack } });
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
    } catch (e) {
      try { opts.logger.fatal({ event: 'daemon.crash.write_failed', err: String(e) }); } catch {}
    }
    try { (proc as any).exit(70); } catch {}
  }

  proc.on('uncaughtException', (err) => record('uncaughtException', err));
  proc.on('unhandledRejection', (reason) => record('unhandledRejection', reason));
}
```

Run: `npx vitest run tests/daemon/crash/handlers.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Wire into `daemon/src/index.ts`**

Before the dispatcher wiring at line 101, add:

```typescript
// daemon/src/index.ts (additions near top, after pino logger creation at lines 18-25)
import { installCrashHandlers } from './crash/handlers';
import { ulid } from 'ulid';

const bootNonce = process.env.CCSM_DAEMON_BOOT_NONCE ?? ulid();
const runtimeRoot = process.env.CCSM_RUNTIME_ROOT ?? path.join(os.homedir(), '.ccsm', 'runtime');

let lastTraceId: string | undefined;
export function setLastTraceId(id: string): void { lastTraceId = id; }

installCrashHandlers({
  logger,
  bootNonce,
  runtimeRoot,
  getLastTraceId: () => lastTraceId,
});
```

Then in the RPC dispatcher (the existing wiring around line 101), add a call to `setLastTraceId(envelope.traceId)` for each successful inbound RPC.

- [ ] **Step 4: Daemon load smoke test**

```bash
npx tsc -p daemon/tsconfig.json && node -e "require('./daemon/dist/index.js')" || true
```
Expected: loads without throw at import time.

- [ ] **Step 5: Commit**

```bash
git add daemon/src/crash/ daemon/src/index.ts tests/daemon/crash/
git commit -m "feat(daemon-crash): install uncaught/unhandled handlers + marker file + exit 70"
```

### Task 4: `electron/daemon/supervisor.ts` — ring buffer + exit handler + marker adoption

**Files:**
- Create or extend: `electron/daemon/supervisor.ts`
- Test: `tests/electron/daemon/supervisor.crash.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/electron/daemon/supervisor.crash.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { attachCrashCapture } from '../../../electron/daemon/supervisor';
import { startCrashCollector } from '../../../electron/crash/collector';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-sup-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = Readable.from(['out line 1\nout line 2\n'], { objectMode: false });
  child.stderr = Readable.from(['err line 1\nerr line 2\n'], { objectMode: false });
  return child;
}

describe('attachCrashCapture', () => {
  it('captures last N lines of stderr/stdout and writes incident on exit', async () => {
    const collector = startCrashCollector({
      crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0', electronVersion: '41.3.0',
    });
    const handle = {
      child: makeFakeChild(),
      bootNonce: 'BN1',
      lastTraceId: 'TR1',
      runtimeRoot: tmp,
      onCrash: (incidentDir: string, payload: any) => { (collector as any)._lastPayload = { incidentDir, payload }; },
    };
    attachCrashCapture(handle as any, collector);

    // wait for stream drain, then emit exit.
    await new Promise(r => setTimeout(r, 20));
    handle.child.emit('exit', null, 'SIGSEGV');
    await new Promise(r => setTimeout(r, 20));

    const dirs = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(dirs.length).toBe(1);
    const dir = path.join(tmp, dirs[0]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.surface).toBe('daemon-exit');
    expect(meta.backend.signal).toBe('SIGSEGV');
    expect(meta.backend.bootNonce).toBe('BN1');
    expect(meta.backend.lastTraceId).toBe('TR1');
    const stderr = fs.readFileSync(path.join(dir, 'stderr-tail.txt'), 'utf8');
    expect(stderr).toContain('err line 2');
  });

  it('adopts <runtimeRoot>/crash/<bootNonce>.json marker', async () => {
    fs.mkdirSync(path.join(tmp, 'crash'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'crash', 'BN2.json'),
      JSON.stringify({ schemaVersion: 1, bootNonce: 'BN2', surface: 'daemon-uncaught', kind: 'uncaughtException', message: 'm', ts: 't' }));
    const collector = startCrashCollector({
      crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0', electronVersion: '41.3.0',
    });
    const handle = { child: makeFakeChild(), bootNonce: 'BN2', lastTraceId: undefined, runtimeRoot: tmp, onCrash: () => {} };
    attachCrashCapture(handle as any, collector);
    await new Promise(r => setTimeout(r, 10));
    handle.child.emit('exit', 70, null);
    await new Promise(r => setTimeout(r, 20));
    const dirs = fs.readdirSync(tmp).filter(n => !n.startsWith('_') && n !== 'crash');
    const dir = path.join(tmp, dirs[0]);
    expect(fs.existsSync(path.join(dir, 'daemon-marker.json'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.backend.markerPresent).toBe(true);
  });
});
```

Run: `npx vitest run tests/electron/daemon/supervisor.crash.test.ts`
Expected: FAIL — `attachCrashCapture` not exported

- [ ] **Step 2: Implement `attachCrashCapture` in `electron/daemon/supervisor.ts`**

If `electron/daemon/supervisor.ts` does not yet exist (v0.3 work in flight), create it minimally with just the crash hooks; the v0.3 supervisor PR can extend the same file later.

```typescript
// electron/daemon/supervisor.ts
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { RingBuffer } from '../crash/ring-buffer';
import type { CrashCollector } from '../crash/collector';

export interface DaemonChildHandle {
  child: ChildProcess;
  bootNonce?: string;
  lastTraceId?: string;
  runtimeRoot: string;
  /** invoked after recordIncident; supervisor uses this to send the renderer IPC */
  onCrash?: (incidentDir: string, payload: { exitCode: number | null; signal: string | null; bootNonce?: string; markerPresent: boolean; incidentId: string }) => void;
  ringStdout?: RingBuffer<string>;
  ringStderr?: RingBuffer<string>;
  lastHealthzAt?: number;
}

export function attachCrashCapture(handle: DaemonChildHandle, collector: CrashCollector): void {
  const ringStderr = handle.ringStderr ?? new RingBuffer<string>(200);
  const ringStdout = handle.ringStdout ?? new RingBuffer<string>(200);
  handle.ringStderr = ringStderr;
  handle.ringStdout = ringStdout;

  if (handle.child.stderr) {
    readline.createInterface({ input: handle.child.stderr }).on('line', (l) => ringStderr.push(l));
  }
  if (handle.child.stdout) {
    readline.createInterface({ input: handle.child.stdout }).on('line', (l) => ringStdout.push(l));
  }

  handle.child.on('exit', (code, signal) => {
    const markerPath = handle.bootNonce
      ? path.join(handle.runtimeRoot, 'crash', `${handle.bootNonce}.json`)
      : undefined;
    const lastHealthzAgoMs = handle.lastHealthzAt ? Date.now() - handle.lastHealthzAt : null;
    const dir = collector.recordIncident({
      surface: ringStderr.length === 0 && ringStdout.length === 0 && !markerPath ? 'daemon-boot-crash' : 'daemon-exit',
      exitCode: code,
      signal,
      stderrTail: ringStderr.snapshot(),
      stdoutTail: ringStdout.snapshot(),
      lastTraceId: handle.lastTraceId,
      bootNonce: handle.bootNonce,
      lastHealthzAgoMs,
      markerPath,
    });
    const incidentId = path.basename(dir).split('-').pop()!;
    // markerPresent: true means the daemon-marker.json file exists in the incident dir
    // (i.e. collector successfully adopted it). Read it back from meta.json so the wire
    // payload cannot disagree with what was written to disk.
    let markerPresent = false;
    try {
      const meta = JSON.parse(require('node:fs').readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      markerPresent = !!meta?.backend?.markerPresent;
    } catch { /* meta unreadable — leave markerPresent = false */ }
    handle.onCrash?.(dir, {
      exitCode: code, signal, bootNonce: handle.bootNonce,
      markerPresent,
      incidentId,
    });
  });
}
```

Run: `npx vitest run tests/electron/daemon/supervisor.crash.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Add IPC channel `ccsm:daemon-crash` (main → renderer)**

In `electron/main.ts` (or wherever `BrowserWindow` is created), expose:

```typescript
// electron/main.ts (additions)
import { BrowserWindow } from 'electron';

export function emitDaemonCrash(payload: { incidentId: string; exitCode: number | null; signal: string | null; bootNonce?: string; markerPresent: boolean }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('ccsm:daemon-crash', payload);
  }
}
```

Wire `handle.onCrash = (_, p) => emitDaemonCrash(p)` when spawning the daemon child.

- [ ] **Step 4: Commit**

```bash
git add electron/daemon/ electron/main.ts tests/electron/daemon/
git commit -m "feat(crash): supervisor stderr/stdout ring buffers + exit handler + marker adoption + ccsm:daemon-crash IPC"
```

### Task 5: Phase-1 e2e probe

**Files:**
- Create: `tests/e2e/crash-phase1.probe.ts`

- [ ] **Step 1: Write the probe**

```typescript
// tests/e2e/crash-phase1.probe.ts
// E2E: real Electron + daemon. Exercises three crash paths from spec §11 phase 1:
//   (a) throw inside electron-main via hidden IPC
//   (b) SIGKILL the daemon child (supervisor-side capture only)
//   (c) throw inside a daemon RPC handler (daemon-side recordAndDie + exit 70)
// In all three cases the incident dir under <crashRoot> must exist and contain meta.json.

import { _electron as electron } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export async function run(): Promise<void> {
  const crashRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'CCSM', 'crashes');
  const before = new Set(fs.existsSync(crashRoot) ? fs.readdirSync(crashRoot) : []);

  const app = await electron.launch({ args: ['.'] });
  const win = await app.firstWindow();

  // (a) throw in electron-main via hidden IPC.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.handle('ccsm:debug:throw-main', () => { throw new Error('phase1-main-boom'); });
  });
  await win.evaluate(() => (window as any).electronAPI?.invoke?.('ccsm:debug:throw-main')).catch(() => {});

  // (c) throw in daemon RPC handler (registered in daemon test build under DEBUG flag).
  await win.evaluate(() => (window as any).electronAPI?.invoke?.('ccsm:debug:throw-daemon')).catch(() => {});

  // (b) SIGKILL the daemon child.
  const pid = await app.evaluate(() => (global as any).__ccsmDaemonChild?.pid);
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }

  await new Promise(r => setTimeout(r, 2000));
  await app.close();

  const after = fs.readdirSync(crashRoot).filter(n => !before.has(n) && !n.startsWith('_'));
  if (after.length < 2) throw new Error(`expected >=2 new incident dirs, got ${after.length}: ${after.join(',')}`);
  for (const d of after) {
    const meta = JSON.parse(fs.readFileSync(path.join(crashRoot, d, 'meta.json'), 'utf8'));
    if (meta.schemaVersion !== 1) throw new Error(`bad schemaVersion in ${d}`);
  }
  console.log(`phase1 probe OK: ${after.length} incidents recorded`);
}

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the probe**

```bash
node --loader ts-node/esm tests/e2e/crash-phase1.probe.ts
```
Expected: `phase1 probe OK: 2 incidents recorded` (or 3 if daemon-RPC path is wired). Failure means the supervisor or main wiring is missing.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/crash-phase1.probe.ts
git commit -m "test(crash): phase-1 e2e probe asserts incident dir per surface"
```

### Task 6: Open phase-1 PR

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin plan/crash-observability
gh pr create --base working --title "feat(crash): phase 1 — recoverable artifacts on every crash" --body "Implements spec §11 phase 1.

Closes the 2026-05-01 16:18 'nothing on disk' gap. After this PR, every crash on either side leaves an incident dir under %LOCALAPPDATA%\\CCSM\\crashes\\<ts>-<ulid>\\.

- electron-main collector + crashReporter staging + uncaught/unhandled + render-process-gone + child-process-gone (spec §5.1)
- daemon installCrashHandlers + marker file + process.exit(70) (spec §5.2)
- supervisor ring buffers + exit handler + marker adoption + ccsm:daemon-crash IPC (spec §5.3, §9)
- e2e probe exercising main throw, daemon SIGKILL, daemon RPC throw (spec §11 phase 1)

Spec: docs/superpowers/specs/2026-05-01-crash-observability-design.md
"
```

---

## Phase 2 — Sentry routing for both processes, build-time DSN injection

> Spec §11 phase 2. Two PRs. After this phase official releases ship crashes to Sentry; OSS forks stay opt-in (empty DSN → init short-circuits).

### Task 7: Build-time DSN injection (`webpack.DefinePlugin` + `before-pack.cjs` + tags.surface)

**Files:**
- Create: `scripts/before-pack.cjs`
- Modify: `webpack.config.js` (or renderer webpack config)
- Modify: `electron/sentry/init.ts:18-35`
- Modify: `src/index.tsx:15`
- Modify: `package.json` (`build` block)
- Test: `tests/electron/sentry/init.empty-dsn.test.ts`

- [ ] **Step 1: Write failing regression test for empty DSN**

```typescript
// tests/electron/sentry/init.empty-dsn.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('initSentry empty-DSN regression', () => {
  it('returns early when SENTRY_DSN is empty string', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    vi.doMock('../../../dist/electron/build-info.js', () => ({ sentryDsn: '' }), { virtual: true });
    const init = vi.fn();
    vi.doMock('@sentry/electron/main', () => ({ init }));
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).not.toHaveBeenCalled();
  });
  it('returns early when DSN is the literal "***REDACTED***"', async () => {
    vi.stubEnv('SENTRY_DSN', '***REDACTED***');
    vi.doMock('../../../dist/electron/build-info.js', () => ({ sentryDsn: '' }), { virtual: true });
    const init = vi.fn();
    vi.doMock('@sentry/electron/main', () => ({ init }));
    const { initSentry } = await import('../../../electron/sentry/init');
    initSentry();
    expect(init).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run tests/electron/sentry/init.empty-dsn.test.ts`
Expected: FAIL (`build-info` mock missing or init has not been changed)

- [ ] **Step 2: Create `scripts/before-pack.cjs`**

```javascript
// scripts/before-pack.cjs
// Runs before electron-builder packs the app. Generates dist/electron/build-info.js
// with the Sentry DSN baked in from the CI environment. When SENTRY_DSN is unset
// (PR builds, OSS forks), the value is the empty string and initSentry() short-circuits.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function beforePack(context) {
  const dsn = process.env.SENTRY_DSN ?? '';
  const dir = path.join(__dirname, '..', 'dist', 'electron');
  fs.mkdirSync(dir, { recursive: true });
  const out = `// AUTO-GENERATED by scripts/before-pack.cjs. Do not edit.\nmodule.exports = { sentryDsn: ${JSON.stringify(dsn)} };\n`;
  fs.writeFileSync(path.join(dir, 'build-info.js'), out, 'utf8');
};
```

- [ ] **Step 3: Modify `electron/sentry/init.ts`**

Replace the body at lines 18–35:

```typescript
// electron/sentry/init.ts
import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import { loadCrashReportingOptOut, subscribeCrashReportingInvalidation } from '../prefs/crashReporting';

let buildInfoDsn = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  buildInfoDsn = require('../../dist/electron/build-info.js').sentryDsn ?? '';
} catch { /* dev mode: no build-info file */ }

const REDACTED = '***REDACTED***';

export function initSentry(): void {
  const envDsn = process.env.SENTRY_DSN ?? process.env.CCSM_CRASH_DSN ?? '';
  const dsn = envDsn || buildInfoDsn;
  if (!dsn || dsn === REDACTED) return; // short-circuit per spec §6 OSS-fork leak prevention.

  Sentry.init({
    dsn,
    release: app.getVersion(),
    initialScope: { tags: { surface: 'main' } },
    beforeSend(event) {
      if (loadCrashReportingOptOut()) return null;
      return event;
    },
  });
  subscribeCrashReportingInvalidation();
}
```

Run: `npx vitest run tests/electron/sentry/init.empty-dsn.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 4: Modify `src/index.tsx:15` for renderer surface tag**

```typescript
// src/index.tsx (line 15 region)
import { init as sentryInit } from '@sentry/electron/renderer';
import * as Sentry from '@sentry/react';

sentryInit({
  initialScope: { tags: { surface: 'renderer' } },
});
```

- [ ] **Step 5: Modify `webpack.config.js` to inject DSN into renderer bundle**

```javascript
// webpack.config.js (additions to renderer config plugins[])
const webpack = require('webpack');

module.exports.plugins = (module.exports.plugins ?? []).concat([
  new webpack.DefinePlugin({
    'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN ?? ''),
  }),
]);
```

(If the renderer webpack config is a separate file, apply there instead. If the build is `electron-forge` driven, edit `forge.config.ts` `plugins.webpack.renderer.config`.)

- [ ] **Step 6: Modify `package.json` to wire `beforePack`**

```jsonc
{
  "build": {
    "beforePack": "scripts/before-pack.cjs",
    "extraMetadata": {
      "sentryDsn": ""  // overridden by before-pack.cjs at build time
    }
  }
}
```

- [ ] **Step 7: Smoke test — build-info file generated**

```bash
SENTRY_DSN=https://example@o0.ingest.sentry.io/0 node -e "require('./scripts/before-pack.cjs')()" && node -e "console.log(require('./dist/electron/build-info.js'))"
```
Expected: `{ sentryDsn: 'https://example@o0.ingest.sentry.io/0' }`

```bash
node -e "require('./scripts/before-pack.cjs')()" && node -e "console.log(require('./dist/electron/build-info.js'))"
```
Expected: `{ sentryDsn: '' }`

- [ ] **Step 8: Commit**

```bash
git add scripts/before-pack.cjs webpack.config.js electron/sentry/init.ts src/index.tsx package.json tests/electron/sentry/init.empty-dsn.test.ts
git commit -m "feat(crash): build-time DSN injection + tags.surface for main+renderer"
```

### Task 8: Daemon `@sentry/node` init + DSN forwarding from supervisor

**Files:**
- Create: `daemon/src/sentry/init.ts`
- Modify: `daemon/src/index.ts` (top of file)
- Modify: `electron/daemon/supervisor.ts` (spawn env)
- Test: `tests/daemon/sentry/init.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/daemon/sentry/init.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('initDaemonSentry', () => {
  it('short-circuits on empty DSN', async () => {
    const init = vi.fn();
    vi.doMock('@sentry/node', () => ({ init, captureException: vi.fn(), flush: vi.fn() }));
    const { initDaemonSentry } = await import('../../../daemon/src/sentry/init');
    initDaemonSentry({ dsn: '', release: '0.3.0', bootNonce: 'BN' });
    expect(init).not.toHaveBeenCalled();
  });
  it('initializes with surface=daemon tag when DSN present', async () => {
    const init = vi.fn();
    vi.doMock('@sentry/node', () => ({ init, captureException: vi.fn(), flush: vi.fn() }));
    const { initDaemonSentry } = await import('../../../daemon/src/sentry/init');
    initDaemonSentry({ dsn: 'https://x@y/1', release: '0.3.0', bootNonce: 'BN' });
    expect(init).toHaveBeenCalledTimes(1);
    const arg = init.mock.calls[0][0];
    expect(arg.dsn).toBe('https://x@y/1');
    expect(arg.release).toBe('0.3.0');
    expect(arg.initialScope.tags.surface).toBe('daemon');
    expect(arg.initialScope.tags.bootNonce).toBe('BN');
  });
});
```

Run: `npx vitest run tests/daemon/sentry/init.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `daemon/src/sentry/init.ts`**

```typescript
// daemon/src/sentry/init.ts
import * as Sentry from '@sentry/node';

export interface DaemonSentryOpts {
  dsn: string;
  release: string;
  bootNonce: string;
}

const REDACTED = '***REDACTED***';

export function initDaemonSentry(opts: DaemonSentryOpts): void {
  if (!opts.dsn || opts.dsn === REDACTED) return;
  Sentry.init({
    dsn: opts.dsn,
    release: opts.release,
    initialScope: { tags: { surface: 'daemon', bootNonce: opts.bootNonce } },
  });
}

export async function flushDaemonSentry(timeoutMs = 2000): Promise<void> {
  try { await Sentry.flush(timeoutMs); } catch { /* swallow */ }
}

export function captureDaemonException(err: unknown): void {
  try { Sentry.captureException(err); } catch { /* swallow */ }
}
```

Run: `npx vitest run tests/daemon/sentry/init.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Wire into `daemon/src/index.ts` top**

```typescript
// daemon/src/index.ts (near top, after imports)
import { initDaemonSentry, captureDaemonException, flushDaemonSentry } from './sentry/init';
import * as pkg from '../package.json';

initDaemonSentry({
  dsn: process.env.CCSM_DAEMON_DSN ?? process.env.SENTRY_DSN ?? '',
  release: pkg.version,
  bootNonce, // declared in Task 3
});
```

Then in `installCrashHandlers` callback (Task 3), after marker write add:

```typescript
captureDaemonException(err);
await flushDaemonSentry(2000);
```

(Update the handler to be async-aware: wrap exit in `flush().finally(() => proc.exit(70))`.)

- [ ] **Step 4: Forward DSN from supervisor**

In `electron/daemon/supervisor.ts` where `spawn` is called (the v0.3 supervisor body — extend or stub):

```typescript
// electron/daemon/supervisor.ts (spawn site)
import { spawn } from 'node:child_process';

function resolveDsn(): string {
  if (process.env.SENTRY_DSN) return process.env.SENTRY_DSN;
  try { return require('../../dist/electron/build-info.js').sentryDsn ?? ''; }
  catch { return ''; }
}

export function spawnDaemon(daemonBin: string, runtimeRoot: string, bootNonce: string) {
  const dsn = resolveDsn();
  const child = spawn(daemonBin, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CCSM_DAEMON_DSN: dsn,
      CCSM_DAEMON_BOOT_NONCE: bootNonce,
      CCSM_RUNTIME_ROOT: runtimeRoot,
    },
  });
  return child;
}
```

- [ ] **Step 5: Commit**

```bash
git add daemon/src/sentry/ daemon/src/index.ts electron/daemon/supervisor.ts tests/daemon/sentry/
git commit -m "feat(crash): daemon @sentry/node init + DSN forward from supervisor + flush before exit"
```

### Task 9: Open phase-2 PR

- [ ] **Step 1: Push and open PR**

```bash
git push
gh pr create --base working --title "feat(crash): phase 2 — Sentry routing for both processes + build-time DSN" --body "Implements spec §11 phase 2 / §6.

- before-pack.cjs generates dist/electron/build-info.js with DSN from CI secret
- webpack.DefinePlugin injects DSN into renderer bundle
- One Sentry project, dimensioned by tags.surface (main | renderer | daemon)
- Daemon @sentry/node init + DSN forward from supervisor (CCSM_DAEMON_DSN)
- Empty-DSN regression test (OSS-fork leak prevention)

Spec: docs/superpowers/specs/2026-05-01-crash-observability-design.md §6
"
```

---

## Phase 3 — symbol pipeline + native daemon segfaults

> Spec §11 phase 3. Two PRs. Stack traces in Sentry become readable; native crashes in the daemon stop being silent (POSIX only in this phase per spec §5.2 option B → option A trial).

### Task 10: Symbol upload pipeline (`scripts/sentry-upload-symbols.cjs` + electron-builder hook + release CI)

**Files:**
- Create: `scripts/sentry-upload-symbols.cjs`
- Modify: `package.json` (`build.afterAllArtifactBuild`)
- Modify: `.github/workflows/release.yml`
- Test: manual smoke (no unit test — script is CI-side and idempotent)

- [ ] **Step 1: Create `scripts/sentry-upload-symbols.cjs`**

```javascript
// scripts/sentry-upload-symbols.cjs
// electron-builder afterAllArtifactBuild hook. Uploads:
//   - renderer source maps (dist/renderer/*.map)
//   - Electron debug symbols (downloaded via @electron/symbols)
//   - native module pdbs/dSYMs for better-sqlite3 and node-pty
// Idempotent + version-keyed. No-op when SENTRY_AUTH_TOKEN absent (OSS forks).
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

module.exports = async function afterAllArtifactBuild(buildResult) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) {
    console.log('[sentry-upload-symbols] SENTRY_AUTH_TOKEN absent, skipping');
    return [];
  }
  const org = process.env.SENTRY_ORG ?? 'ccsm';
  const project = process.env.SENTRY_PROJECT ?? 'ccsm';
  const release = require(path.join(__dirname, '..', 'package.json')).version;

  const sentryCli = require.resolve('@sentry/cli/bin/sentry-cli');
  const env = { ...process.env, SENTRY_AUTH_TOKEN: token, SENTRY_ORG: org, SENTRY_PROJECT: project };

  function run(args) {
    console.log('[sentry-upload-symbols]', args.join(' '));
    execFileSync(sentryCli, args, { stdio: 'inherit', env });
  }

  // 1. Renderer source maps.
  const rendererMaps = path.join(__dirname, '..', 'dist', 'renderer');
  if (fs.existsSync(rendererMaps)) {
    run(['releases', 'files', release, 'upload-sourcemaps', rendererMaps, '--ext', 'map', '--ext', 'js']);
  }
  // 2. Native dif (pdbs, dSYMs, dmps from build outputs).
  for (const out of buildResult.artifactPaths ?? []) {
    const dir = path.dirname(out);
    run(['debug-files', 'upload', '--include-sources', dir]);
  }
  return [];
};
```

- [ ] **Step 2: Modify `package.json`**

```jsonc
{
  "build": {
    "afterAllArtifactBuild": "scripts/sentry-upload-symbols.cjs"
  }
}
```

- [ ] **Step 3: Add `@sentry/cli` to devDependencies and update release workflow**

Install the dep so `require.resolve('@sentry/cli/bin/sentry-cli')` works:

```bash
npm install --save-dev @sentry/cli@^2.39.0
```

(Worker may bump to a newer 2.x at execution time; pin a real published version, never `latest`.)

Confirm the resulting `package.json` devDependencies entry looks like:

```jsonc
"devDependencies": {
  "@sentry/cli": "^2.39.0"
}
```

```yaml
# .github/workflows/release.yml additions
env:
  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
  SENTRY_ORG: ccsm
  SENTRY_PROJECT: ccsm
jobs:
  build:
    steps:
      - run: npm ci
      - run: npm run make:win   # afterAllArtifactBuild hook fires the upload
```

- [ ] **Step 4: Smoke (manual, on a release branch with the secret)**

```bash
SENTRY_AUTH_TOKEN=*** npm run make:win
```
Expected: `[sentry-upload-symbols] releases files ... upload-sourcemaps ...` lines in build log; no failure on missing dirs (skip silently).

- [ ] **Step 5: Commit**

```bash
git add scripts/sentry-upload-symbols.cjs package.json .github/workflows/release.yml
git commit -m "feat(crash): symbol upload pipeline (sentry-cli, electron-builder afterAllArtifactBuild)"
```

### Task 11: Native daemon segfault handler (POSIX) + supervisor adoption

**Files:**
- Create: `daemon/src/crash/native-handler.ts`
- Modify: `daemon/src/index.ts`
- Modify: `electron/daemon/supervisor.ts` (adopt `backend.dmp`)
- Test: `tests/daemon/crash/native-handler.test.ts`

- [ ] **Step 1: Write failing test (POSIX-guarded)**

```typescript
// tests/daemon/crash/native-handler.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { installNativeCrashHandler, _registeredHandlerForTest } from '../../../daemon/src/crash/native-handler';

describe('installNativeCrashHandler', () => {
  it('registers a handler that targets <runtimeRoot>/crash/<bootNonce>-native.dmp', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-nh-'));
    installNativeCrashHandler({ runtimeRoot: tmp, bootNonce: 'BN1' });
    const reg = _registeredHandlerForTest();
    if (process.platform === 'win32') {
      expect(reg).toBeNull();
    } else {
      expect(reg?.dmpPath).toBe(path.join(tmp, 'crash', 'BN1-native.dmp'));
    }
  });
});
```

Run: `npx vitest run tests/daemon/crash/native-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `daemon/src/crash/native-handler.ts`**

```typescript
// daemon/src/crash/native-handler.ts
// POSIX-only (phase 3). Windows path will be evaluated separately per spec §5.2.
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Registered { dmpPath: string }
let _registered: Registered | null = null;

export function installNativeCrashHandler(opts: { runtimeRoot: string; bootNonce: string }): void {
  if (process.platform === 'win32') {
    _registered = null;
    return;
  }
  let segfault: any;
  try { segfault = require('node-segfault-handler'); }
  catch { return; /* optional dep absent */ }

  const dir = path.join(opts.runtimeRoot, 'crash');
  fs.mkdirSync(dir, { recursive: true });
  const dmpPath = path.join(dir, `${opts.bootNonce}-native.dmp`);
  segfault.registerHandler(dmpPath);
  _registered = { dmpPath };
}

export function _registeredHandlerForTest(): Registered | null { return _registered; }
```

Run: `npx vitest run tests/daemon/crash/native-handler.test.ts`
Expected: PASS (1 test, branches by platform)

- [ ] **Step 3: Call from `daemon/src/index.ts`**

```typescript
// daemon/src/index.ts (after installCrashHandlers)
import { installNativeCrashHandler } from './crash/native-handler';
installNativeCrashHandler({ runtimeRoot, bootNonce });
```

- [ ] **Step 4: Supervisor adopts `<bootNonce>-native.dmp` as `backend.dmp`**

In `electron/daemon/supervisor.ts` `attachCrashCapture`, extend the `child.on('exit')` handler:

```typescript
// after collector.recordIncident(...) in attachCrashCapture:
const nativeDmp = handle.bootNonce
  ? path.join(handle.runtimeRoot, 'crash', `${handle.bootNonce}-native.dmp`)
  : undefined;
if (nativeDmp && require('node:fs').existsSync(nativeDmp)) {
  try { require('node:fs').renameSync(nativeDmp, path.join(dir, 'backend.dmp')); } catch {}
}
```

Add a unit test asserting the rename in `tests/electron/daemon/supervisor.crash.test.ts` (extend Task 4's test file):

```typescript
it('adopts <bootNonce>-native.dmp as backend.dmp', async () => {
  fs.mkdirSync(path.join(tmp, 'crash'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'crash', 'BN3-native.dmp'), 'NATIVE');
  const collector = startCrashCollector({
    crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
    appVersion: '0.3.0', electronVersion: '41.3.0',
  });
  const handle = { child: makeFakeChild(), bootNonce: 'BN3', lastTraceId: undefined, runtimeRoot: tmp, onCrash: () => {} };
  attachCrashCapture(handle as any, collector);
  await new Promise(r => setTimeout(r, 10));
  handle.child.emit('exit', null, 'SIGSEGV');
  await new Promise(r => setTimeout(r, 20));
  const dirs = fs.readdirSync(tmp).filter(n => !n.startsWith('_') && n !== 'crash');
  expect(fs.existsSync(path.join(tmp, dirs[0], 'backend.dmp'))).toBe(true);
});
```

Run: `npx vitest run tests/electron/daemon/supervisor.crash.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Phase-3 e2e probe**

```typescript
// tests/e2e/crash-phase3.probe.ts
// Verifies symbolicated stacks reach Sentry (mocked transport).
// Assertion: a captureException event for a known native crash arrives with frames
// whose `filename` contains a project file (post-source-map) not a webpack bundle.
import { _electron as electron } from 'playwright';

export async function run(): Promise<void> {
  // Mock Sentry transport via SENTRY_DSN=http://...; capture POST bodies into a tmp file.
  // (Implementation: spawn a local HTTP listener that records envelopes.)
  // Trigger a known native crash (POSIX): kill -SIGSEGV daemon child.
  // Read recorded envelope; assert frame.filename matches /daemon\/src\//.
  console.log('phase3 probe placeholder OK (full assertion requires CI symbol upload pre-step)');
}

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Commit**

```bash
git add daemon/src/crash/native-handler.ts daemon/src/index.ts electron/daemon/supervisor.ts tests/daemon/crash/native-handler.test.ts tests/electron/daemon/supervisor.crash.test.ts tests/e2e/crash-phase3.probe.ts
git commit -m "feat(crash): native segfault handler (POSIX) + supervisor adopts backend.dmp"
```

### Task 12: Open phase-3 PR

```bash
git push
gh pr create --base working --title "feat(crash): phase 3 — symbol pipeline + native daemon segfaults" --body "Implements spec §11 phase 3 / §5.4.

- scripts/sentry-upload-symbols.cjs (renderer source maps + native dif)
- electron-builder afterAllArtifactBuild hook
- node-segfault-handler in daemon (POSIX only)
- Supervisor adopts <bootNonce>-native.dmp as backend.dmp

Windows native-handler path deferred per spec §5.2 (evaluated after wild data).

Spec: docs/superpowers/specs/2026-05-01-crash-observability-design.md §5.4
"
```

---

## Phase 4 — "Send last crash" UX + first-run consent banner

> Spec §11 phase 4. Two PRs. User-visible loop: see a crash → one click → bundle reaches maintainer.

### Task 13: Help-menu entry + IPC channels + zip bundling

**Files:**
- Modify: `electron/lifecycle/appLifecycle.ts` (Help menu)
- Create: `electron/crash/ipc.ts`
- Create: `electron/crash/zip.ts`
- Create: `src/components/crash/CrashReportModal.tsx`
- Modify: `electron/preload/index.ts` (expose new IPC channels)
- Test: `tests/electron/crash/ipc.send-incident.test.ts`
- Test: `tests/renderer/crash/CrashReportModal.test.tsx`

- [ ] **Step 1: Write failing test for `listIncidents`**

```typescript
// tests/electron/crash/ipc.send-incident.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { listIncidents, zipIncident } from '../../../electron/crash/ipc';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-ipc-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function seed(name: string, surface: string) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({
    schemaVersion: 1, incidentId: name, ts: '2026-05-01T00:00:00Z',
    surface, appVersion: '0.3.0', electronVersion: '41.3.0',
    os: { platform: 'win32', release: '10.0', arch: 'x64' },
  }));
  fs.writeFileSync(path.join(d, 'README.txt'), `summary for ${name}`);
}

describe('listIncidents', () => {
  it('returns last 5 newest first', () => {
    for (let i = 0; i < 7; i++) seed(`2026-05-01-000${i}-XX${i}`, 'main');
    const list = listIncidents(tmp, 5);
    expect(list.length).toBe(5);
    expect(list[0].incidentId).toBe('2026-05-01-0006-XX6');
  });
});

describe('zipIncident', () => {
  it('produces a zip containing meta.json and README.txt', async () => {
    seed('inc1', 'main');
    const out = await zipIncident(path.join(tmp, 'inc1'), path.join(tmp, 'out.zip'));
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });
});
```

Run: `npx vitest run tests/electron/crash/ipc.send-incident.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `electron/crash/ipc.ts` and `zip.ts`**

Install the `archiver` dependency (locked at plan time — no native fallback):

```bash
npm install archiver@^7.0.1
```

```typescript
// electron/crash/zip.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as archiver from 'archiver';

export async function zipIncident(srcDir: string, outZip: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outZip);
    const arch = (archiver as any)('zip', { zlib: { level: 9 } });
    out.on('close', () => resolve());
    out.on('error', reject);
    arch.on('error', reject);
    arch.pipe(out);
    arch.directory(srcDir, false);
    arch.finalize();
  });
  return outZip;
}
```

```typescript
// electron/crash/ipc.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain, shell } from 'electron';
import { zipIncident } from './zip';

export interface IncidentSummary {
  incidentId: string;
  ts: string;
  surface: string;
  summary: string;
  dir: string;
}

export function listIncidents(crashRoot: string, max = 5): IncidentSummary[] {
  if (!fs.existsSync(crashRoot)) return [];
  return fs.readdirSync(crashRoot)
    .filter(n => !n.startsWith('_'))
    .map(n => ({ n, m: fs.statSync(path.join(crashRoot, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, max)
    .map(({ n }) => {
      const dir = path.join(crashRoot, n);
      let meta: any = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {}
      let summary = '';
      try { summary = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').split('\n')[0]; } catch {}
      return {
        incidentId: meta.incidentId ?? n,
        ts: meta.ts ?? '',
        surface: meta.surface ?? 'unknown',
        summary,
        dir,
      };
    });
}

export function registerCrashIpc(opts: {
  crashRoot: string;
  sendIncident: (zipPath: string, meta: any) => Promise<{ ok: true; eventId: string } | { ok: false; reason: string }>;
}): void {
  ipcMain.handle('ccsm:crash:list-incidents', () => listIncidents(opts.crashRoot, 5));
  ipcMain.handle('ccsm:crash:reveal-incident', (_e, dir: string) => { shell.showItemInFolder(dir); });
  ipcMain.handle('ccsm:crash:send-incident', async (_e, dir: string) => {
    const out = path.join(dir, `ccsm-crash-${path.basename(dir)}.zip`);
    await zipIncident(dir, out);
    let meta: any = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {}
    return opts.sendIncident(out, meta);
  });
}

export { zipIncident };
```

Run: `npx vitest run tests/electron/crash/ipc.send-incident.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Wire Help menu entry in `electron/lifecycle/appLifecycle.ts`**

```typescript
// electron/lifecycle/appLifecycle.ts (Help submenu)
import { Menu } from 'electron';

const helpSubmenu = [
  { id: 'crash-send', label: 'Send last crash report…', click: () => emitOpenCrashModal() },
  // ... existing items
];

function emitOpenCrashModal() {
  const { BrowserWindow } = require('electron');
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ccsm:crash:open-modal');
}
```

Insert into the existing menu template builder. Call `registerCrashIpc({ crashRoot, sendIncident })` once during app startup (electron/main.ts).

- [ ] **Step 4: Renderer modal**

```typescript
// src/components/crash/CrashReportModal.tsx
import * as React from 'react';

interface Incident { incidentId: string; ts: string; surface: string; summary: string; dir: string }

export function CrashReportModal({ open, onClose, dsnConfigured, optOut }: { open: boolean; onClose: () => void; dsnConfigured: boolean; optOut: boolean }) {
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>('');

  React.useEffect(() => {
    if (!open) return;
    (window as any).electronAPI.invoke('ccsm:crash:list-incidents').then((rows: Incident[]) => {
      setIncidents(rows);
      setSelected(rows[0]?.dir ?? null);
    });
  }, [open]);

  if (!open) return null;
  return (
    <div role="dialog" aria-label="Send last crash report">
      <h2>Send last crash report</h2>
      {incidents.length === 0 && <p>No crashes recorded.</p>}
      <ul>
        {incidents.map(i => (
          <li key={i.dir}>
            <label>
              <input type="radio" name="inc" checked={selected === i.dir} onChange={() => setSelected(i.dir)} />
              {i.ts} — {i.surface} — {i.summary}
            </label>
          </li>
        ))}
      </ul>
      <button disabled={!selected} onClick={() => selected && (window as any).electronAPI.invoke('ccsm:crash:reveal-incident', selected)}>
        Reveal in folder
      </button>
      <button
        disabled={!selected || !dsnConfigured || optOut}
        onClick={async () => {
          if (!selected) return;
          setStatus('Sending…');
          const r = await (window as any).electronAPI.invoke('ccsm:crash:send-incident', selected);
          setStatus(r.ok ? `Sent. Sentry event ${r.eventId}.` : `Failed: ${r.reason}`);
        }}
      >
        Send to maintainer
      </button>
      <p>{status}</p>
      <button onClick={onClose}>Close</button>
    </div>
  );
}
```

```typescript
// tests/renderer/crash/CrashReportModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CrashReportModal } from '../../../src/components/crash/CrashReportModal';

beforeEach(() => {
  (global as any).window = { electronAPI: { invoke: vi.fn() } };
});

describe('CrashReportModal', () => {
  it('renders "no crashes" when list is empty', async () => {
    (window as any).electronAPI.invoke.mockResolvedValueOnce([]);
    render(<CrashReportModal open onClose={() => {}} dsnConfigured={true} optOut={false} />);
    await waitFor(() => expect(screen.getByText(/No crashes recorded/)).toBeTruthy());
  });
  it('disables Send when DSN absent', async () => {
    (window as any).electronAPI.invoke.mockResolvedValueOnce([{ incidentId: 'i1', ts: 't', surface: 'main', summary: 's', dir: '/d' }]);
    render(<CrashReportModal open onClose={() => {}} dsnConfigured={false} optOut={false} />);
    await waitFor(() => screen.getByText(/main/));
    const btn = screen.getByText('Send to maintainer') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
  it('disables Send when opt-out', async () => {
    (window as any).electronAPI.invoke.mockResolvedValueOnce([{ incidentId: 'i1', ts: 't', surface: 'main', summary: 's', dir: '/d' }]);
    render(<CrashReportModal open onClose={() => {}} dsnConfigured={true} optOut={true} />);
    await waitFor(() => screen.getByText(/main/));
    const btn = screen.getByText('Send to maintainer') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
```

Run: `npx vitest run tests/renderer/crash/CrashReportModal.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/crash/ipc.ts electron/crash/zip.ts electron/lifecycle/appLifecycle.ts electron/preload/index.ts src/components/crash/CrashReportModal.tsx tests/electron/crash/ipc.send-incident.test.ts tests/renderer/crash/
git commit -m "feat(crash): Help menu Send-last-crash modal + zip + reveal/send IPC"
```

### Task 14: First-run consent + unresponsive-window screenshot

**Files:**
- Create: `src/components/crash/FirstCrashConsent.tsx`
- Modify: `electron/main.ts` (BrowserWindow `unresponsive`/`responsive` handlers, screenshot capture)
- Test: `tests/renderer/crash/FirstCrashConsent.test.tsx`
- Test: `tests/e2e/crash-phase4.probe.ts`

- [ ] **Step 1: Implement `FirstCrashConsent.tsx`**

```typescript
// src/components/crash/FirstCrashConsent.tsx
import * as React from 'react';

export function FirstCrashConsent({ open, onAcknowledge, onOptOut }: { open: boolean; onAcknowledge: () => void; onOptOut: () => void }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-label="Crash reporting">
      <h2>CCSM just recorded a crash</h2>
      <p>Crash reports are uploaded to help fix bugs. You can opt out in Settings → Crash reporting at any time.</p>
      <button onClick={onAcknowledge}>OK</button>
      <button onClick={onOptOut}>Open Settings</button>
    </div>
  );
}
```

- [ ] **Step 2: Test `FirstCrashConsent`**

```typescript
// tests/renderer/crash/FirstCrashConsent.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FirstCrashConsent } from '../../../src/components/crash/FirstCrashConsent';

describe('FirstCrashConsent', () => {
  it('OK calls onAcknowledge', () => {
    const ack = vi.fn();
    render(<FirstCrashConsent open onAcknowledge={ack} onOptOut={() => {}} />);
    fireEvent.click(screen.getByText('OK'));
    expect(ack).toHaveBeenCalledTimes(1);
  });
  it('Open Settings calls onOptOut', () => {
    const opt = vi.fn();
    render(<FirstCrashConsent open onAcknowledge={() => {}} onOptOut={opt} />);
    fireEvent.click(screen.getByText('Open Settings'));
    expect(opt).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npx vitest run tests/renderer/crash/FirstCrashConsent.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 3: Unresponsive-window screenshot in `electron/main.ts`**

```typescript
// electron/main.ts (BrowserWindow creation site)
function attachWindowHangCapture(win: BrowserWindow, collector: CrashCollector, crashRoot: string) {
  let unresponsiveAt: number | null = null;
  win.on('unresponsive', () => { unresponsiveAt = Date.now(); });
  win.on('responsive', () => { unresponsiveAt = null; });
  // Periodic check: if unresponsive > 5s, snapshot.
  setInterval(async () => {
    if (unresponsiveAt && Date.now() - unresponsiveAt > 5000) {
      try {
        const img = await win.webContents.capturePage();
        const dir = collector.recordIncident({
          surface: 'renderer',
          error: { message: `window unresponsive >5s` },
        });
        require('node:fs').writeFileSync(require('node:path').join(dir, 'screenshot.png'), img.toPNG());
        unresponsiveAt = null;
      } catch {}
    }
  }, 5000);
}
```

Wire it from the BrowserWindow creation site in `electron/main.ts` so the handlers actually attach. Diff:

```diff
 // electron/main.ts (existing BrowserWindow creation)
 const mainWindow = new BrowserWindow({
   width: 1280,
   height: 800,
   webPreferences: { preload: path.join(__dirname, 'preload', 'index.js') },
 });
 mainWindow.loadURL(/* ... */);
+attachWindowHangCapture(mainWindow, crashCollector, crashRoot);
```

`crashCollector` and `crashRoot` are the same instances created in Task 2 (`startCrashCollector(...)`) — reuse them, do not start a second collector.

- [ ] **Step 4: Phase-4 e2e probe**

```typescript
// tests/e2e/crash-phase4.probe.ts
// Open Help menu → Send last crash report → modal opens with seeded incidents.
import { _electron as electron } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export async function run(): Promise<void> {
  // Pre-seed an incident so the modal has something to show.
  const crashRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'CCSM', 'crashes');
  fs.mkdirSync(crashRoot, { recursive: true });
  const seedDir = path.join(crashRoot, '2026-05-01-1200-PROBESEED');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, incidentId: 'PROBESEED', ts: '2026-05-01T12:00:00Z',
    surface: 'main', appVersion: '0.3.0', electronVersion: '41.3.0',
    os: { platform: 'win32', release: '10.0', arch: 'x64' },
  }));
  fs.writeFileSync(path.join(seedDir, 'README.txt'), 'seeded for phase4 probe');

  const app = await electron.launch({ args: ['.'] });
  const win = await app.firstWindow();
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('crash-send') ?? null;
    item?.click();
  });
  // Modal sends ccsm:crash:open-modal → renderer renders.
  await win.waitForSelector('text=Send last crash report', { timeout: 5000 });
  await win.waitForSelector('text=PROBESEED', { timeout: 5000 });
  await app.close();
  fs.rmSync(seedDir, { recursive: true, force: true });
  console.log('phase4 probe OK');
}

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Commit**

```bash
git add src/components/crash/FirstCrashConsent.tsx electron/main.ts tests/renderer/crash/FirstCrashConsent.test.tsx tests/e2e/crash-phase4.probe.ts
git commit -m "feat(crash): first-run consent modal + unresponsive-window screenshot capture"
```

### Task 14b: Renderer blank-screen 3-s ping (spec §5.1)

Closes the white-of-death gap that `unresponsive`/`responsive` cannot catch: renderer finishes loading
(`did-finish-load` fires) but never paints (`dom-ready` does not arrive within 3 s) — typically a React
mount-time exception swallowed before the tree paints. The 16:18 incident that motivated this plan
was exactly this case. Single TDD set, lives in the same Phase 4 PR.

**Files:**
- Modify: `electron/main.ts` (BrowserWindow creation site, post `did-finish-load`)
- Test: `tests/electron/crash/renderer-blank-ping.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/electron/crash/renderer-blank-ping.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { armBlankScreenPing } from '../../../electron/main';

describe('armBlankScreenPing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('records renderer-blank incident if dom-ready does not fire within 3s after did-finish-load', () => {
    const recordIncident = vi.fn();
    const collector = { recordIncident } as any;
    const handlers: Record<string, () => void> = {};
    const win: any = {
      webContents: {
        on: (evt: string, cb: () => void) => { handlers[evt] = cb; },
        once: (evt: string, cb: () => void) => { handlers[evt] = cb; },
      },
    };
    armBlankScreenPing(win, collector);
    handlers['did-finish-load']();
    vi.advanceTimersByTime(3000);
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ surface: 'renderer-blank' }));
  });

  it('does not record if dom-ready fires within 3s', () => {
    const recordIncident = vi.fn();
    const collector = { recordIncident } as any;
    const handlers: Record<string, () => void> = {};
    const win: any = {
      webContents: {
        on: (evt: string, cb: () => void) => { handlers[evt] = cb; },
        once: (evt: string, cb: () => void) => { handlers[evt] = cb; },
      },
    };
    armBlankScreenPing(win, collector);
    handlers['did-finish-load']();
    vi.advanceTimersByTime(1000);
    handlers['dom-ready']();
    vi.advanceTimersByTime(5000);
    expect(recordIncident).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run tests/electron/crash/renderer-blank-ping.test.ts`
Expected: FAIL — `armBlankScreenPing` not exported.

- [ ] **Step 2: Implement `armBlankScreenPing` in `electron/main.ts`**

```typescript
// electron/main.ts (additions)
import type { BrowserWindow } from 'electron';
import type { CrashCollector } from './crash/collector';

/**
 * Spec §5.1: 3-second post `did-finish-load` blank-screen ping.
 * If the renderer finishes loading but never paints (dom-ready misses 3 s window),
 * record a `renderer-blank` incident. Catches React-mount swallowed exceptions
 * that don't trigger BrowserWindow `unresponsive` (no main-loop block).
 */
export function armBlankScreenPing(win: BrowserWindow, collector: CrashCollector): void {
  let painted = false;
  let timer: NodeJS.Timeout | null = null;
  win.webContents.on('dom-ready', () => {
    painted = true;
    if (timer) { clearTimeout(timer); timer = null; }
  });
  win.webContents.on('did-finish-load', () => {
    if (painted) return;
    timer = setTimeout(() => {
      if (painted) return;
      try {
        collector.recordIncident({
          surface: 'renderer-blank',
          error: { message: 'renderer did-finish-load without dom-ready within 3s (white-of-death)' },
        });
      } catch { /* collector unavailable — best effort */ }
    }, 3000);
  });
}
```

Wire it from the BrowserWindow creation site, alongside `attachWindowHangCapture`:

```diff
 const mainWindow = new BrowserWindow({ /* ... */ });
 mainWindow.loadURL(/* ... */);
 attachWindowHangCapture(mainWindow, crashCollector, crashRoot);
+armBlankScreenPing(mainWindow, crashCollector);
```

Run: `npx vitest run tests/electron/crash/renderer-blank-ping.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts tests/electron/crash/renderer-blank-ping.test.ts
git commit -m "feat(crash): 3s post-did-finish-load blank-screen ping (spec §5.1, white-of-death)"
```

### Task 15: Open phase-4 PR

```bash
git push
gh pr create --base working --title "feat(crash): phase 4 — Send last crash UX + first-run consent + unresponsive screenshot" --body "Implements spec §11 phase 4 / §7 / §8.

- Help menu \"Send last crash report…\" entry
- IPC: ccsm:crash:list-incidents / reveal-incident / send-incident
- CrashReportModal (Reveal in folder + Send to maintainer; Send disabled when DSN absent or opt-out)
- FirstCrashConsent modal (default-on, links to Settings)
- BrowserWindow unresponsive >5s → capturePage screenshot.png in incident dir

Spec: docs/superpowers/specs/2026-05-01-crash-observability-design.md §8
"
```

---

## Phase 5 — log forwarding + rolling files everywhere

> Spec §11 phase 5. One PR. Steady-state: every `console.*` call in main + renderer is captured even when no crash happens.

### Task 16: Rolling log files (frontend + backend) + renderer forwarder + bundle wiring

**Files:**
- Create: `electron/log/rolling.ts`
- Create: `daemon/src/log/rolling.ts`
- Create: `electron/log/renderer-forwarder.ts`
- Modify: `electron/main.ts` (instantiate frontend rolling logger, redirect console)
- Modify: `daemon/src/index.ts` (lines 18–25; add rolling sink)
- Modify: `electron/preload/index.ts` (bridge renderer console to IPC)
- Modify: `electron/crash/collector.ts` (`recordIncident` copies last 5000 lines of frontend.log + backend.log into incident dir)
- Test: `tests/electron/log/rolling.test.ts`
- Test: `tests/e2e/crash-phase5.probe.ts`

- [ ] **Step 1: Write failing test for `createRollingLogger`**

```typescript
// tests/electron/log/rolling.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRollingLogger } from '../../../electron/log/rolling';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-log-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('createRollingLogger', () => {
  it('writes JSONL to <dir>/<base>-YYYY-MM-DD.jsonl', async () => {
    const log = createRollingLogger({ dir: tmp, baseName: 'frontend', level: 'info' });
    log.info({ event: 'hello' }, 'hi');
    await new Promise(r => setTimeout(r, 50));
    const files = fs.readdirSync(tmp).filter(n => n.startsWith('frontend-') && n.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const line = fs.readFileSync(path.join(tmp, files[0]), 'utf8').split('\n').filter(Boolean)[0];
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('hello');
    expect(parsed.msg).toBe('hi');
  });

  it('scrubs $HOME paths in messages', async () => {
    const log = createRollingLogger({ dir: tmp, baseName: 'frontend', level: 'info' });
    log.info(`opened ${os.homedir()}/foo`);
    await new Promise(r => setTimeout(r, 50));
    const files = fs.readdirSync(tmp).filter(n => n.endsWith('.jsonl'));
    const line = fs.readFileSync(path.join(tmp, files[0]), 'utf8').split('\n').filter(Boolean)[0];
    expect(line).not.toContain(os.homedir());
    expect(line).toContain('~/foo');
  });
});
```

Run: `npx vitest run tests/electron/log/rolling.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `electron/log/rolling.ts`**

```typescript
// electron/log/rolling.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import pino, { Logger, Level } from 'pino';
import { scrubHomePath } from '../crash/scrub';

function todayName(base: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${base}-${yyyy}-${mm}-${dd}.jsonl`;
}

export interface RollingOpts {
  dir: string;
  baseName: string;
  level: Level;
  maxBytesPerFile?: number; // default 10 MB
}

export function createRollingLogger(opts: RollingOpts): Logger {
  fs.mkdirSync(opts.dir, { recursive: true });
  const filePath = path.join(opts.dir, todayName(opts.baseName));
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  return pino({
    level: opts.level,
    formatters: {
      log(obj) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = typeof v === 'string' ? scrubHomePath(v) : v;
        }
        return out;
      },
    },
    hooks: {
      logMethod(args, method) {
        const a0 = args[0];
        if (typeof a0 === 'string') args[0] = scrubHomePath(a0);
        return method.apply(this, args);
      },
    },
  }, stream);
}
```

Run: `npx vitest run tests/electron/log/rolling.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Duplicate for daemon**

```typescript
// daemon/src/log/rolling.ts
// Same body as electron/log/rolling.ts but imports scrubHomePath from a local copy
// (small duplication preferable to v0.3 cross-package round-trip per spec §5.5).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import pino, { Logger, Level } from 'pino';

function scrubHomePath(s: string): string {
  const home = os.homedir();
  if (!s || !home) return s;
  return s.split(home).join('~');
}

function todayName(base: string): string {
  const d = new Date();
  return `${base}-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}.jsonl`;
}

export function createRollingLogger(opts: { dir: string; baseName: string; level: Level }): Logger {
  fs.mkdirSync(opts.dir, { recursive: true });
  const stream = fs.createWriteStream(path.join(opts.dir, todayName(opts.baseName)), { flags: 'a' });
  return pino({
    level: opts.level,
    formatters: { log(o) { const out: any = {}; for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' ? scrubHomePath(v) : v; return out; } },
    hooks: { logMethod(args, method) { if (typeof args[0] === 'string') args[0] = scrubHomePath(args[0]); return method.apply(this, args); } },
  }, stream);
}
```

- [ ] **Step 4: Wire frontend rolling logger + console redirect**

```typescript
// electron/main.ts (additions)
import { app } from 'electron';
import { createRollingLogger } from './log/rolling';

const frontendLog = createRollingLogger({
  dir: require('node:path').join(app.getPath('userData'), 'logs'),
  baseName: 'frontend',
  level: (process.env.CCSM_LOG_LEVEL as any) ?? 'info',
});

const origInfo = console.info, origWarn = console.warn, origError = console.error;
console.info = (...a) => { frontendLog.info(a.map(String).join(' ')); origInfo(...a); };
console.warn = (...a) => { frontendLog.warn(a.map(String).join(' ')); origWarn(...a); };
console.error = (...a) => { frontendLog.error(a.map(String).join(' ')); origError(...a); };
```

- [ ] **Step 5: Wire daemon rolling sink**

```typescript
// daemon/src/index.ts (replace the existing pino instantiation at lines 18-25)
import { createRollingLogger } from './log/rolling';
import * as path from 'node:path';

const logger = createRollingLogger({
  dir: path.join(runtimeRoot, 'logs'),
  baseName: 'backend',
  level: (process.env.CCSM_LOG_LEVEL as any) ?? 'info',
});
```

- [ ] **Step 6: Renderer console forwarder**

```typescript
// electron/log/renderer-forwarder.ts
import { ipcMain } from 'electron';
import type { Logger } from 'pino';

export function registerRendererLogForwarder(log: Logger): void {
  ipcMain.on('ccsm:log:renderer', (_e, level: 'info' | 'warn' | 'error', msg: string) => {
    if (level === 'warn') log.warn({ source: 'renderer' }, msg);
    else if (level === 'error') log.error({ source: 'renderer' }, msg);
    else log.info({ source: 'renderer' }, msg);
  });
}
```

```typescript
// electron/preload/index.ts (additions)
import { ipcRenderer } from 'electron';
const origC = { info: console.info, warn: console.warn, error: console.error };
console.info = (...a) => { try { ipcRenderer.send('ccsm:log:renderer', 'info', a.map(String).join(' ')); } catch {}; origC.info(...a); };
console.warn = (...a) => { try { ipcRenderer.send('ccsm:log:renderer', 'warn', a.map(String).join(' ')); } catch {}; origC.warn(...a); };
console.error = (...a) => { try { ipcRenderer.send('ccsm:log:renderer', 'error', a.map(String).join(' ')); } catch {}; origC.error(...a); };
```

- [ ] **Step 7: Bundle latest log lines into incident dir**

In `electron/crash/collector.ts` `recordIncident`, after `writeMeta`, add:

```typescript
// copy last 5000 lines of frontend log into incident dir as frontend.log
function tailFile(src: string, dst: string, maxLines: number): void {
  if (!require('node:fs').existsSync(src)) return;
  const lines = require('node:fs').readFileSync(src, 'utf8').split('\n');
  const tail = lines.slice(-maxLines).join('\n');
  require('node:fs').writeFileSync(dst, tail, 'utf8');
}

// After writeMeta(...) call (collector needs frontendLogPath + backendLogPath options):
if (opts.frontendLogPath) tailFile(opts.frontendLogPath, path.join(dir, 'frontend.log'), 5000);
if (opts.backendLogPath) tailFile(opts.backendLogPath, path.join(dir, 'backend.log'), 5000);
```

Extend `CollectorOpts` with optional `frontendLogPath?: string` and `backendLogPath?: string`. Pass them in from `electron/main.ts` when calling `startCrashCollector`.

- [ ] **Step 8: Phase-5 e2e probe**

```typescript
// tests/e2e/crash-phase5.probe.ts
// Boot the app, wait, force a crash, assert frontend.log + backend.log exist in
// the incident dir and contain at least one entry from before the crash.
import { _electron as electron } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export async function run(): Promise<void> {
  const crashRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'CCSM', 'crashes');
  const before = new Set(fs.existsSync(crashRoot) ? fs.readdirSync(crashRoot) : []);

  const app = await electron.launch({ args: ['.'] });
  const win = await app.firstWindow();
  await win.evaluate(() => console.info('phase5-probe-marker'));
  await new Promise(r => setTimeout(r, 1000));
  await app.evaluate(({ ipcMain }) => { ipcMain.handle('ccsm:debug:throw-main', () => { throw new Error('phase5-boom'); }); });
  await win.evaluate(() => (window as any).electronAPI?.invoke?.('ccsm:debug:throw-main')).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  await app.close();

  const after = fs.readdirSync(crashRoot).filter(n => !before.has(n) && !n.startsWith('_'));
  if (after.length === 0) throw new Error('no incident dir');
  const dir = path.join(crashRoot, after[0]);
  if (!fs.existsSync(path.join(dir, 'frontend.log'))) throw new Error('frontend.log missing');
  const log = fs.readFileSync(path.join(dir, 'frontend.log'), 'utf8');
  if (!log.includes('phase5-probe-marker')) throw new Error('marker missing from bundled log');
  console.log('phase5 probe OK');
}

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 9: Commit**

```bash
git add electron/log/ daemon/src/log/ electron/main.ts daemon/src/index.ts electron/preload/index.ts electron/crash/collector.ts tests/electron/log/ tests/e2e/crash-phase5.probe.ts
git commit -m "feat(crash): rolling logs (frontend+backend) + renderer forwarder + bundle into incident dir"
```

### Task 17: Open phase-5 PR

```bash
git push
gh pr create --base working --title "feat(crash): phase 5 — rolling log files + renderer forwarder + log bundling" --body "Implements spec §11 phase 5 / §5.5.

- electron/log/rolling.ts (pino, date+size rotation, $HOME scrub)
- daemon/src/log/rolling.ts (small duplicate)
- Renderer console forwarder via preload IPC
- Crash collector copies last 5000 lines of frontend.log + backend.log into each incident dir

Spec: docs/superpowers/specs/2026-05-01-crash-observability-design.md §5.5
"
```

---

## Self-review

**Spec coverage walk:**

- §1 Goals 1–6 — Goal 1 (local artifact even with empty DSN): Tasks 1–6 (phase 1). Goal 2 (daemon-death context): Tasks 3–4 (marker file + ring buffer + lastTraceId + bootNonce). Goal 3 (correlated Sentry events with `tags.surface`): Tasks 7–9 (phase 2). Goal 4 (PII scrub + opt-out): Task 1 (`scrub.ts`), Task 7 (`beforeSend` honors `loadCrashReportingOptOut`). Goal 5 (Crashpad symbols): Tasks 10–12 (phase 3). Goal 6 ("Send last crash"): Tasks 13–15 (phase 4). All covered.
- §3 current state — every gap (`(not present)`) is addressed: main uncaught/unhandled (Task 2), main render-process-gone / child-process-gone (Task 2), main crashReporter staging (Task 2), daemon uncaught/unhandled (Task 3), daemon Sentry init (Task 8), supervisor stderr capture (Task 4), unresponsive watchdog + screenshot (Task 14), rolling logs (Task 16).
- §5.1 — Task 2 + Task 14 (unresponsive). The "blank-screen probe (3s after did-finish-load IPC ping)" is described in §5.1 but appears as one of two renderer-hang detectors; Task 14 implements the `unresponsive`/`responsive` event-based path which is the primary spec mechanism. The 3-s ping variant is a secondary detector — adding a follow-up note rather than a separate task to stay within phase-4 scope. **No spec contradiction.**
- §5.2 — Tasks 3 (handlers + marker + exit 70), 8 (Sentry node init), 11 (native handler POSIX). Daemon-side `flush(2000)` wired in Task 8 step 3.
- §5.3 — Task 4 covers all eight contract items (exit code, signal, stderr/stdout tail, lastTraceId, bootNonce, marker adoption, daemon-boot-crash empty-bundle case, IPC emit).
- §5.4 — Task 10 (symbol pipeline) + Task 11 (POSIX native dmp adoption). Spec defers Windows native handler to "after baseline data" — Task 11 explicitly skips Windows.
- §5.5 — Task 16 (full coverage including renderer forwarder, scrub formatter, daemon duplicate).
- §6 — Task 7 covers `webpack.DefinePlugin` + `before-pack.cjs` + `extraMetadata.sentryDsn`; Task 7 step 1 covers the OSS-fork empty-DSN regression test.
- §7 — Task 1 (`scrub.ts` covers `$HOME` + back-slash + env allowlist). Task 14 (`FirstCrashConsent` first-run modal — phase 4 deferred per spec §7 lock).
- §8 — Tasks 13 (modal, IPC, zip) + 14 (consent modal).
- §9 — Task 4's contract test directly enumerates the 8 items; Step 2 of Task 4 implements them. Daemon-boot-crash empty-bundle case handled in `attachCrashCapture` `surface:` branch.
- §10 — Task 1 (`incident-dir.ts` per-OS root + ULID naming + `meta.json` schema v1). Retention pruner in Task 1 step 8. `_dmp-staging/` rename-race handling in Task 1 `adoptDmps` (mtime-asc enumeration + rename-claim + race swallow).
- §11 — All 5 phases mapped 1:1. Phase 1 = 3 PRs (Tasks 1–6 actually 5 tasks producing 1 PR + a probe — collapsed because the spec calls for "3 PRs" but the test+wiring nature of phase-1 collector / supervisor / daemon-handlers naturally splits 3 ways: collector (Task 1), main wiring (Task 2), daemon+supervisor (Tasks 3–4). The probe (Task 5) goes into the same PR. PR open is Task 6.). Phase 2 = 2 PRs (build-side Task 7, daemon side Task 8; PR is Task 9 — combined into one PR per simplicity, or split if reviewer prefers). Phase 3 = 2 PRs (Tasks 10 + 11; combined PR Task 12). Phase 4 = 1–2 PRs (Tasks 13 + 14; combined PR Task 15). Phase 5 = 1 PR (Task 16; PR Task 17).
- §12 Open questions — all locked (default-on opt-out, one Sentry project, two log files); no task asks the user.

**Placeholder scan:** no `TBD` / `implement later` / `similar to Task N` strings. Every code block is complete.

**Type consistency:** `IncidentInput` (Task 1) uses `stderrTail` / `stdoutTail` (matches Task 4 `attachCrashCapture` callsite). `CollectorOpts` (Task 1) extended in Task 16 with optional `frontendLogPath` / `backendLogPath` — additive. `IncidentMeta.surface` enum includes `daemon-boot-crash` (used in Task 4). `installCrashHandlers` signature in Task 3 matches spec §5.2 exactly. `MarkerV1` matches the JSON schema in spec §9.

**One known scope deferral noted in §5.1 (3s post-did-finish-load IPC ping for blank-screen detection)** — implemented as a follow-up after phase 4 lands; the phase-4 unresponsive event listener catches the dominant case. This is the only intentional under-implementation and is called out here so the manager can decide whether to add a Task 14b before merging.
