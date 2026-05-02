import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ----------------------------------------------------------------------------
// Verify-chain tests for the updater (frag-6-7 §7.3, Task #137)
//
// Coverage matrix:
//   - SLSA accept  → install proceeds, no canonical log line
//   - SLSA reject  → install refused, canonical `updater_verify_fail {kind:'slsa'}`
//   - Linux minisign reject → install refused, canonical `kind:'minisign'`
//   - Auto-update gate OFF → autoDownload + autoInstallOnAppQuit are false
//                          + periodic checks are skipped
//   - Linux non-existent platform short-circuits minisign as ok
//
// Mocks: same shape as updater.test.ts so the two suites share intuitions.
// ----------------------------------------------------------------------------

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
type Listener = (payload: unknown) => void;

const ipcHandlers = new Map<string, IpcHandler>();
const webContentsSends: Array<{ channel: string; payload: unknown }> = [];
const autoUpdaterEmitter = new EventEmitter();
const state = {
  appIsPackaged: true,
  appVersion: '0.1.2',
  appName: 'CCSM',
  checkForUpdatesImpl: (async () => ({ updateInfo: {} })) as () => Promise<unknown>,
  downloadUpdateImpl: (async () => undefined) as () => Promise<unknown>,
};
const quitAndInstallCalls: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];

vi.mock('electron', () => {
  const ipcMain = {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler);
    },
  };
  const BrowserWindow = {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) =>
            webContentsSends.push({ channel, payload }),
        },
      },
    ],
  };
  const app = {
    get isPackaged() {
      return state.appIsPackaged;
    },
    getVersion: () => state.appVersion,
    getName: () => state.appName,
  };
  return { ipcMain, BrowserWindow, app };
});

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    logger: null as unknown,
    on: (event: string, listener: Listener) => {
      autoUpdaterEmitter.on(event, listener);
    },
    checkForUpdates: () => state.checkForUpdatesImpl(),
    downloadUpdate: () => state.downloadUpdateImpl(),
    quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => {
      quitAndInstallCalls.push({ isSilent, isForceRunAfter });
    },
  };
  return { autoUpdater };
});

function resetState() {
  ipcHandlers.clear();
  webContentsSends.length = 0;
  autoUpdaterEmitter.removeAllListeners();
  quitAndInstallCalls.length = 0;
  state.appIsPackaged = true;
  state.appVersion = '0.1.2';
  state.appName = 'CCSM';
  state.checkForUpdatesImpl = async () => ({ updateInfo: {} });
  state.downloadUpdateImpl = async () => undefined;
}

async function freshModuleWithGate(gate: boolean) {
  resetState();
  const mod = await import('../index');
  mod.__resetUpdaterForTests();
  mod.__setAutoUpdateGateForTests(gate);
  // Default to accept-all so individual cases can override per-test.
  const verifySlsa = await import('../verifySlsa');
  verifySlsa.__setVerifyImpl(async () => ({ ok: true }));
  const verifyMinisign = await import('../verifyMinisign');
  verifyMinisign.__setMinisignRunner(async () => ({ code: 0, stderr: '' }));
  mod.installUpdaterIpc();
  return mod;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

function canonicalLogLines(): string[] {
  return consoleErrorSpy.mock.calls
    .map((args) => String(args[0] ?? ''))
    .filter((line) => line.startsWith('updater_verify_fail '));
}

// ============================================================================
// Auto-update gate (CCSM_DAEMON_AUTOUPDATE)
// ============================================================================

describe('updater verify: auto-update gate', () => {
  it('gate OFF → autoDownload + autoInstallOnAppQuit are false', async () => {
    await freshModuleWithGate(false);
    const { autoUpdater } = await import('electron-updater');
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('gate ON → autoDownload + autoInstallOnAppQuit are true', async () => {
    await freshModuleWithGate(true);
    const { autoUpdater } = await import('electron-updater');
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('isAutoUpdateGateEnabled reflects the env state', async () => {
    const mod = await freshModuleWithGate(false);
    expect(mod.isAutoUpdateGateEnabled()).toBe(false);
    mod.__setAutoUpdateGateForTests(true);
    expect(mod.isAutoUpdateGateEnabled()).toBe(true);
  });
});

// ============================================================================
// SLSA verify
// ============================================================================

describe('updater verify: SLSA', () => {
  it('accept → install proceeds, no canonical log line', async () => {
    await freshModuleWithGate(true);
    const verifySlsa = await import('../verifySlsa');
    verifySlsa.__setVerifyImpl(async () => ({ ok: true }));

    autoUpdaterEmitter.emit('update-downloaded', {
      version: '0.2.0',
      downloadedFile: '/tmp/ccsm.AppImage',
    });
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    await new Promise((r) => setImmediate(r));
    expect(quitAndInstallCalls).toHaveLength(1);
    expect(canonicalLogLines()).toEqual([]);
  });

  it('reject → install refused with verify-failed, canonical log line emitted', async () => {
    await freshModuleWithGate(true);
    const verifySlsa = await import('../verifySlsa');
    verifySlsa.__setVerifyImpl(async () => ({
      ok: false,
      reason: 'bad_certificate_chain',
    }));

    autoUpdaterEmitter.emit('update-downloaded', {
      version: '0.2.0',
      downloadedFile: '/tmp/ccsm.AppImage',
    });
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: false, reason: 'verify-failed' });
    await new Promise((r) => setImmediate(r));
    expect(quitAndInstallCalls).toEqual([]);

    const lines = canonicalLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^updater_verify_fail \{"kind":"slsa","reason":"bad_certificate_chain"\}$/);

    // Renderer also gets the error broadcast so the user sees something.
    const errorSends = webContentsSends.filter((s) => s.channel === 'updates:status');
    expect(errorSends.some((s) => (s.payload as { kind: string }).kind === 'error')).toBe(true);
  });

  it('reject when downloadedFile is missing → kind=slsa, reason=artifact_path_missing', async () => {
    await freshModuleWithGate(true);
    autoUpdaterEmitter.emit('update-downloaded', { version: '0.2.0' });
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: false, reason: 'verify-failed' });
    const lines = canonicalLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"kind":"slsa"');
    expect(lines[0]).toContain('"reason":"artifact_path_missing"');
  });
});

// ============================================================================
// Minisign verify (Linux only)
// ============================================================================

describe('updater verify: Linux minisign', () => {
  it('Linux reject → install refused, canonical log kind=minisign', async () => {
    await freshModuleWithGate(true);
    // Patch verifyDownloadedArtifact's minisign side: SLSA passes, minisign
    // fails. We do this by writing the artifact to disk so verifyMinisign
    // gets past the existence check, then forcing the runner to non-zero.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-verify-'));
    const artifact = path.join(tmp, 'ccsm.AppImage');
    fs.writeFileSync(artifact, 'fake binary');
    fs.writeFileSync(`${artifact}.minisig`, 'fake sig');
    try {
      const verifyMinisign = await import('../verifyMinisign');
      verifyMinisign.__setMinisignRunner(async () => ({
        code: 1,
        stderr: 'Signature verification failed',
      }));

      // Force the verify orchestrator to think we're on Linux. The
      // verifyDownloadedArtifact API takes an optional platform; we exercise
      // it indirectly by calling it directly here.
      const mod = await import('../index');
      const result = await mod.verifyDownloadedArtifact({
        artifactPath: artifact,
        platform: 'linux',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('minisign');
        expect(result.reason).toContain('minisign_exit_1');
      }
      const lines = canonicalLogLines();
      expect(lines.some((l) => l.includes('"kind":"minisign"'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('non-Linux platform short-circuits minisign as ok (skipped)', async () => {
    await freshModuleWithGate(true);
    const verifyMinisign = await import('../verifyMinisign');
    // Even with a runner that would fail, the platform gate must skip it.
    verifyMinisign.__setMinisignRunner(async () => ({ code: 99, stderr: 'should not run' }));
    const result = await verifyMinisign.verifyMinisign({
      artifactPath: '/nonexistent',
      signaturePath: '/nonexistent.minisig',
      platform: 'win32',
    });
    expect(result).toEqual({ ok: true, skipped: 'non-linux' });
  });

  it('Linux missing artifact → reason=artifact_missing', async () => {
    const verifyMinisign = await import('../verifyMinisign');
    const result = await verifyMinisign.verifyMinisign({
      artifactPath: '/definitely/not/a/real/path.AppImage',
      signaturePath: '/definitely/not/a/real/path.AppImage.minisig',
      platform: 'linux',
    });
    expect(result).toEqual({ ok: false, reason: 'artifact_missing' });
  });

  it('exposes a stable pubkey fingerprint matching the on-disk release-keys file', async () => {
    const { minisignPubkeyFingerprint, MINISIGN_PUBKEY } = await import('../verifyMinisign');
    const fp = minisignPubkeyFingerprint();
    // sha256 hex = 64 chars. Stable across runs because the constant is
    // hardcoded; rotation procedure changes both this and the on-disk file.
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // Hardcoded constant matches the comment header (key ID).
    expect(MINISIGN_PUBKEY).toContain('D1146C005BA0E1F3');
    expect(MINISIGN_PUBKEY).toContain('RWTz4aBbAGwU0RyPzS5uDEFeoFoLMCxaFMhjMYPAyYYK5pbHvKNREKIX');
  });
});

// ============================================================================
// SLSA module unit tests (independent of the orchestrator)
// ============================================================================

describe('verifySlsaProvenance: pre-flight + seam', () => {
  it('artifact missing → reason=artifact_missing', async () => {
    const { verifySlsaProvenance, __setVerifyImpl } = await import('../verifySlsa');
    __setVerifyImpl(null); // exercise the default path's pre-flight check
    const result = await verifySlsaProvenance({
      artifactPath: '/definitely/not/a/real/path',
      bundlePath: '/definitely/not/a/real/path.intoto.jsonl',
    });
    expect(result).toEqual({ ok: false, reason: 'artifact_missing' });
  });

  it('bundle missing → reason=bundle_missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-slsa-'));
    const artifact = path.join(tmp, 'ccsm.AppImage');
    fs.writeFileSync(artifact, 'x');
    try {
      const { verifySlsaProvenance, __setVerifyImpl } = await import('../verifySlsa');
      __setVerifyImpl(null);
      const result = await verifySlsaProvenance({
        artifactPath: artifact,
        bundlePath: `${artifact}.intoto.jsonl`,
      });
      expect(result).toEqual({ ok: false, reason: 'bundle_missing' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('seam: thrown exceptions are caught and surfaced as slsa_verify_threw', async () => {
    const { verifySlsaProvenance, __setVerifyImpl } = await import('../verifySlsa');
    __setVerifyImpl(async () => {
      throw new Error('kaboom');
    });
    const result = await verifySlsaProvenance({
      artifactPath: '/x',
      bundlePath: '/x.intoto.jsonl',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('slsa_verify_threw');
      expect(result.reason).toContain('kaboom');
    }
  });
});
