import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  bootstrapNotify,
  registerToastTarget,
  lookupToastTarget,
  consumeToastTarget,
  autoSetupAumid,
  __resetBootstrapForTests,
} from '../notify-bootstrap';

// Stub electron's BrowserWindow + app + Notification surface — the test
// process is plain node so importing `electron` would attempt to resolve the
// binary. We only need `getAllWindows` for `shouldSuppressForFocus` (covered
// in the e2e probe instead), `app.isPackaged` for `autoSetupAumid`, and a
// Notification stub so the wrapper's static `Notification.isSupported()` call
// resolves cleanly.
let isPackagedForTest = false;
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported(): boolean {
      return true;
    }
    on(): void {}
    show(): void {}
    close(): void {}
  },
  app: {
    get isPackaged() {
      return isPackagedForTest;
    },
  },
}));

// Mock child_process + fs as full modules — `child_process.spawn` is non-
// configurable on the imported namespace so vi.spyOn can't redefine it. Same
// trick for `fs.existsSync` to keep both branches under test control.
// Use vi.hoisted so the mock factories can close over the spy fns (vi.mock
// is hoisted above import statements; without hoisted spies the factories
// would see undefined locals).
const { spawnMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  // Must include `default` because notify-bootstrap is compiled with
  // esModuleInterop+CommonJS, and vitest's loader rejects partial mocks of
  // modules whose consumer expects a default-export interop slot.
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: existsSyncMock },
    existsSync: existsSyncMock,
  };
});

describe('notify-bootstrap', () => {
  beforeEach(() => {
    __resetBootstrapForTests();
  });

  it('bootstrapNotify is a no-op on non-win32 and never throws', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      // Router never gets called because we early-return; passing a throwing
      // router proves the no-op path doesn't invoke it.
      const router = vi.fn(() => {
        throw new Error('should not fire');
      });
      const result = bootstrapNotify(router);
      expect(result).toBe(false);
      expect(router).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('toast target registry round-trips a single entry', () => {
    registerToastTarget('toast-1', 'session-A', 'permission');
    const t = lookupToastTarget('toast-1');
    expect(t).toEqual({ sessionId: 'session-A', kind: 'permission' });
    consumeToastTarget('toast-1');
    expect(lookupToastTarget('toast-1')).toBeUndefined();
  });

  it('registry evicts the oldest entry when the cap is exceeded', () => {
    // Cap is 256 (private constant); seed 257 entries and assert the first
    // one is gone. Iteration order on Map is insertion order in JS.
    for (let i = 0; i < 257; i++) {
      registerToastTarget(`toast-${i}`, `session-${i}`, 'turn_done');
    }
    expect(lookupToastTarget('toast-0')).toBeUndefined();
    expect(lookupToastTarget('toast-256')).toBeDefined();
    // Cleanup so other tests aren't polluted.
    for (let i = 1; i < 257; i++) consumeToastTarget(`toast-${i}`);
  });

  it('bootstrapNotify is idempotent — second call leaves the first router intact', () => {
    if (process.platform !== 'win32') return; // win32-only path
    const r1 = vi.fn();
    const r2 = vi.fn();
    expect(bootstrapNotify(r1)).toBe(true);
    // Second call should not replace r1 (we deliberately freeze the router so
    // in-flight toasts can't be orphaned by a re-bootstrap).
    expect(bootstrapNotify(r2)).toBe(true);
    // The wrapper would call r1 on activation; r2 must remain unused.
    expect(r2).not.toHaveBeenCalled();
  });
});

// W4 added an automated AUMID Start Menu shortcut setup in dev mode so users
// running `npm run dev` no longer have to manually invoke
// `scripts/setup-aumid.ps1`. Three branches matter:
//   1. Non-Windows → no spawn (impl is a Windows-only path).
//   2. Windows + packaged build → no spawn (NSIS owns the shortcut).
//   3. Windows + dev + .lnk missing → spawn powershell with setup-aumid.ps1.
// The fourth path (Windows + dev + .lnk present) must NOT spawn so the user's
// existing shortcut isn't clobbered.
describe('autoSetupAumid (W4)', () => {
  const originalPlatform = process.platform;

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      // Real impl calls `.on('error', ...)` and `.unref()` on the handle.
      on: () => {},
      unref: () => {},
    });
    existsSyncMock.mockReset();
    isPackagedForTest = false;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('non-Windows → no spawn (Linux)', () => {
    setPlatform('linux');
    autoSetupAumid();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('non-Windows → no spawn (Darwin)', () => {
    setPlatform('darwin');
    autoSetupAumid();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('Windows + packaged → no spawn (NSIS owns the shortcut)', () => {
    setPlatform('win32');
    isPackagedForTest = true;
    autoSetupAumid();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('Windows + dev + .lnk already exists → no spawn (do not clobber)', () => {
    setPlatform('win32');
    isPackagedForTest = false;
    existsSyncMock.mockReturnValue(true);
    autoSetupAumid();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('Windows + dev + .lnk missing → spawn powershell with setup-aumid.ps1 (detached)', () => {
    setPlatform('win32');
    isPackagedForTest = false;
    // First existsSync (the .lnk) → false (missing); second (the script
    // itself) → true so we don't bail on missing-script.
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    autoSetupAumid();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0];
    expect(call[0]).toBe('powershell');
    const args = call[1] as string[];
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-ExecutionPolicy');
    expect(args).toContain('Bypass');
    expect(args.some((a) => a.endsWith('setup-aumid.ps1'))).toBe(true);
    const opts = call[2] as { detached?: boolean; stdio?: string };
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
  });

  it('Windows + dev + script missing → no spawn (logs a warn instead of crashing)', () => {
    setPlatform('win32');
    isPackagedForTest = false;
    // .lnk missing → check passes; script missing → bail out without spawning.
    existsSyncMock.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    autoSetupAumid();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
