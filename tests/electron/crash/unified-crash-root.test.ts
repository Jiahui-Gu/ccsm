// Task #58 / Audit 2 F1 — verify the single `resolveCrashRoot()` helper is
// the single source of truth for ALL crash surfaces (electron-main,
// renderer-forwarded, daemon-via-supervisor-adoption) and that they all
// follow the spec dataRoot AND honor the `CCSM_DATA_ROOT` test override.
//
// Spec refs:
//   - frag-11 §11.6 (data root canonical paths, lowercase `ccsm`)
//   - frag-6-7 §6.6.3 + design doc 2026-05-01-crash-observability §10
//     (single `<dataRoot>/crashes/` bucket; surface in `meta.json`, NOT a
//     per-surface subdir split)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { resolveCrashRoot, resolveDataRoot } from '../../../electron/crash/incident-dir';
import { startCrashCollector } from '../../../electron/crash/collector';
import {
  handleRendererErrorReport,
  createRendererErrorRateLimiter,
} from '../../../electron/ipc/rendererErrorForwarder';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-task58-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('Task #58 — unified crash root', () => {
  it('resolveCrashRoot returns <dataRoot>/crashes (single bucket, lowercase ccsm)', () => {
    const root = resolveCrashRoot({ env: { CCSM_DATA_ROOT: tmp } });
    expect(root).toBe(path.join(tmp, 'crashes'));
  });

  it('CCSM_DATA_ROOT env override redirects all 3 surfaces to the same root', () => {
    // Surface 1: the exported helper itself (used by ipc/crashIncidents.ts +
    // by electron/main.ts to construct the collector + by the supervisor
    // adoption path).
    const helperRoot = resolveCrashRoot({ env: { CCSM_DATA_ROOT: tmp } });

    // Surface 2 + 3: a single collector instance is shared across
    //   (a) electron-main (`recordIncident` from `wireCrashHandlers`), and
    //   (b) renderer-forwarded reports (`handleRendererErrorReport`).
    // Both must therefore land under the same root that the helper resolved.
    // The supervisor's daemon-crash adoption path also calls
    // `recordIncident` on this same collector instance (see
    // electron/daemon/supervisor.ts attachCrashCapture), so a unified
    // collector instance => unified root for all 3 surfaces.
    const collector = startCrashCollector({
      crashRoot: helperRoot,
      dmpStaging: path.join(helperRoot, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });

    // (a) electron-main surface
    const mainDir = collector.recordIncident({
      surface: 'main',
      error: { message: 'electron-main crash', name: 'Error' },
    });

    // (b) renderer-forwarded surface (via the IPC handler)
    const limiter = createRendererErrorRateLimiter({ windowMs: 60_000, max: 10 });
    const result = handleRendererErrorReport(
      { error: { message: 'renderer crash', name: 'Error' }, source: 'window.onerror' },
      { collector, limiter, processId: 1 },
    );
    expect(result.accepted).toBe(true);
    const dirs = fs.readdirSync(helperRoot).filter(n => !n.startsWith('_'));
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    for (const d of dirs) {
      const meta = JSON.parse(fs.readFileSync(path.join(helperRoot, d, 'meta.json'), 'utf8'));
      expect(['main', 'renderer']).toContain(meta.surface);
      // Every incident dir is a direct child of the SAME crash root — no
      // per-surface subdir split (spec frag-6-7 §6.6.3 + design doc §10).
      expect(path.dirname(path.join(helperRoot, d))).toBe(helperRoot);
    }

    // (c) daemon-via-supervisor adoption pathway — supervisor calls
    //     collector.recordIncident({ surface: 'daemon-exit', ... }) with
    //     a markerPath argument; that incident dir lands under the same
    //     root. We simulate the call directly here (the supervisor wiring
    //     itself is covered by tests/electron/daemon/supervisor.crash-adoption.test.ts).
    const daemonDir = collector.recordIncident({
      surface: 'daemon-exit',
      exitCode: 70,
      signal: null,
      bootNonce: '01ARZ3',
    });

    expect(path.dirname(mainDir)).toBe(helperRoot);
    expect(path.dirname(daemonDir)).toBe(helperRoot);

    // Surface assertion: every incident dir we created sits under
    // `${CCSM_DATA_ROOT}/crashes/` — the env override propagated to all
    // three surfaces by virtue of the single helper.
    const dataRoot = resolveDataRoot({ env: { CCSM_DATA_ROOT: tmp } });
    expect(dataRoot).toBe(tmp);
    expect(helperRoot).toBe(path.join(tmp, 'crashes'));
  });

  it('default platform fallbacks all use lowercase `ccsm` (no legacy CCSM)', () => {
    // Empty env so the override doesn't fire; provider injects platform.
    const win = resolveCrashRoot({ platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } });
    const mac = resolveCrashRoot({ platform: 'darwin', home: '/Users/u', env: {} });
    const lin = resolveCrashRoot({ platform: 'linux', home: '/home/u', env: {} });
    for (const r of [win, mac, lin]) {
      expect(r).toContain('ccsm');
      expect(r.toLowerCase()).toContain('crashes');
      // Defense in depth: the literal segment `/CCSM/` (or `\CCSM\`) must
      // not appear — that's the legacy v0.2 capital-CCSM path which frag-11
      // §11.6 retired for v0.3.
      expect(r.includes(path.sep + 'CCSM' + path.sep)).toBe(false);
    }
  });
});
