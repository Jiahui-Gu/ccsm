// tests/electron/crash/local-write-with-opted-out-renderer.test.ts
//
// Phase 5 hard-constraint regression (mirror of phase 4 local-write test for
// the renderer surface). Local crash logs MUST keep writing for renderer
// errors regardless of `crashUploadConsent` value. Only the network-upload
// path (Sentry) is gated.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../electron/prefs/crashConsent', () => ({
  isCrashUploadAllowed: () => false,
  loadCrashConsent: () => 'opted-out',
}));

import { startCrashCollector } from '../../../electron/crash/collector';
import {
  handleRendererErrorReport,
  createRendererErrorRateLimiter,
} from '../../../electron/ipc/rendererErrorForwarder';

let tmpRoot: string;
beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-crash-renderer-test-')); });
afterEach(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

describe('local crash log writer — renderer surface', () => {
  it('writes the renderer incident dir + meta.json even when consent is opted-out', () => {
    const collector = startCrashCollector({
      crashRoot: path.join(tmpRoot, 'crashes'),
      dmpStaging: path.join(tmpRoot, 'crashes', '_dmp-staging'),
      appVersion: '0.3.0-test',
      electronVersion: '41.0.0',
    });
    const limiter = createRendererErrorRateLimiter({ windowMs: 60_000, max: 10 });
    const out = handleRendererErrorReport(
      {
        error: { name: 'ReferenceError', message: 'x is not defined', stack: 'at Renderer (app.tsx:10)' },
        source: 'window.onerror',
      },
      { collector, limiter, processId: 1 }
    );
    expect(out.accepted).toBe(true);
    const dirs = fs.readdirSync(path.join(tmpRoot, 'crashes')).filter((n) => !n.startsWith('_'));
    expect(dirs.length).toBe(1);
    const dir = path.join(tmpRoot, 'crashes', dirs[0]!);
    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.surface).toBe('renderer');
    expect(meta.appVersion).toBe('0.3.0-test');
  });
});
