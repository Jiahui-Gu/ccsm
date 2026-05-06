// Task #639 — verify electron/main.ts shows the hard-fail screen and
// does NOT createWindow when spawnDaemon rejects with DaemonHardFailError.
//
// Pure unit test on createHardFailScreen + the path-selection logic.
// The actual electron/main.ts boot is hard to drive end-to-end without
// launching electron itself (covered by harness-ui daemon-hard-fail-screen).
// Here we pin the createHardFailScreen factory contract: it builds an HTML
// payload that includes the reason + an optional detail block, encodes
// safely (escaping HTML metacharacters in the daemon-supplied message),
// and avoids preload / nodeIntegration / contextIsolation hooks.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron — we only need BrowserWindow to be a constructor we can
// spy on, and `app` for the version + quit hook.
type WinOpts = {
  webPreferences?: { sandbox?: boolean; nodeIntegration?: boolean; contextIsolation?: boolean };
  width?: number;
  height?: number;
  title?: string;
};
const browserWindowCtorCalls: WinOpts[] = [];
const loadedUrls: string[] = [];

class FakeBrowserWindow {
  destroyed = false;
  closeListeners: Array<() => void> = [];
  closedListeners: Array<() => void> = [];
  constructor(opts: WinOpts) {
    browserWindowCtorCalls.push(opts);
  }
  loadURL(url: string): Promise<void> {
    loadedUrls.push(url);
    return Promise.resolve();
  }
  focus(): void { /* no-op */ }
  isDestroyed(): boolean { return this.destroyed; }
  on(evt: string, cb: () => void): void {
    if (evt === 'closed') this.closedListeners.push(cb);
    if (evt === 'close') this.closeListeners.push(cb);
  }
}

const appQuitSpy = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  app: {
    getVersion: () => '0.3.0-test',
    quit: () => appQuitSpy(),
  },
}));

vi.mock('../electron/branding/icon', () => ({
  buildAppIcon: () => null,
}));

let mod: typeof import('../electron/window/createHardFailScreen');

beforeEach(async () => {
  browserWindowCtorCalls.length = 0;
  loadedUrls.length = 0;
  appQuitSpy.mockReset();
  vi.resetModules();
  mod = await import('../electron/window/createHardFailScreen');
  mod.__resetForTests();
});

describe('createHardFailScreen (Task #639)', () => {
  it('creates a BrowserWindow with sandboxed webPreferences (no preload, no node integration)', () => {
    const win = mod.createHardFailScreen({
      reason: 'Daemon failed to start (exit code 1).',
      detail: '[daemon] FATAL: critical startup module data.js threw',
    });
    expect(win).toBeDefined();
    expect(browserWindowCtorCalls).toHaveLength(1);
    const opts = browserWindowCtorCalls[0];
    expect(opts.webPreferences?.sandbox).toBe(true);
    expect(opts.webPreferences?.nodeIntegration).toBe(false);
    expect(opts.webPreferences?.contextIsolation).toBe(true);
    // Title makes the OS surface "ccsm — startup failed" rather than
    // electron-default. Useful for triage screenshots / accessibility.
    expect(opts.title).toMatch(/startup failed/i);
  });

  it('loads a data: URL with the reason embedded in the body', () => {
    mod.createHardFailScreen({
      reason: 'Daemon failed to start (exit code 1).',
    });
    expect(loadedUrls).toHaveLength(1);
    const url = loadedUrls[0];
    expect(url.startsWith('data:text/html')).toBe(true);
    const decoded = decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ''));
    expect(decoded).toContain('Daemon failed to start (exit code 1).');
    expect(decoded).toContain('data-testid="hard-fail-screen"');
    expect(decoded).toContain('data-testid="hard-fail-reason"');
  });

  it('escapes HTML metacharacters in reason and detail to prevent injection from daemon stderr', () => {
    mod.createHardFailScreen({
      reason: '<script>alert(1)</script>',
      detail: 'fail "value" & <bad>',
    });
    const decoded = decodeURIComponent(loadedUrls[0].replace(/^data:text\/html;charset=utf-8,/, ''));
    // The literal <script> tag MUST NOT appear in the output.
    expect(decoded).not.toContain('<script>alert(1)</script>');
    // Escaped form should appear instead.
    expect(decoded).toContain('&lt;script&gt;');
    expect(decoded).toContain('&lt;bad&gt;');
    expect(decoded).toContain('&quot;value&quot;');
  });

  it('omits the detail block when no detail is provided', () => {
    mod.createHardFailScreen({ reason: 'short reason' });
    const decoded = decodeURIComponent(loadedUrls[0].replace(/^data:text\/html;charset=utf-8,/, ''));
    expect(decoded).not.toContain('Daemon stderr');
    expect(decoded).not.toContain('<details');
  });

  it('is idempotent — second call updates the existing window, does not spawn a second BrowserWindow', () => {
    mod.createHardFailScreen({ reason: 'first' });
    expect(browserWindowCtorCalls).toHaveLength(1);
    mod.createHardFailScreen({ reason: 'second' });
    expect(browserWindowCtorCalls).toHaveLength(1);
    expect(loadedUrls).toHaveLength(2);
    const second = decodeURIComponent(loadedUrls[1].replace(/^data:text\/html;charset=utf-8,/, ''));
    expect(second).toContain('second');
  });

  it('quits the app when the user closes the hard-fail window', () => {
    const win = mod.createHardFailScreen({ reason: 'r' });
    expect(appQuitSpy).not.toHaveBeenCalled();
    // Trigger the close listener that production code wired.
    const fake = win as unknown as FakeBrowserWindow;
    for (const cb of fake.closeListeners) cb();
    expect(appQuitSpy).toHaveBeenCalledTimes(1);
  });
});
