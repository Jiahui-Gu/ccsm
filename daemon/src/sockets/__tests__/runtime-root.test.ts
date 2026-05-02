import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveRuntimeRoot, userHash } from '../runtime-root.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ccsm-runtime-root-'));
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('resolveRuntimeRoot — Linux', () => {
  it('uses XDG_RUNTIME_DIR/ccsm when set and writable', () => {
    const xdg = join(scratch, 'xdg');
    mkdirSync(xdg, { recursive: true, mode: 0o700 });
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: xdg, HOME: scratch },
    });
    expect(root).toBe(join(xdg, 'ccsm'));
    expect(existsSync(root)).toBe(true);
  });

  it('falls back to <dataRoot>/run when XDG_RUNTIME_DIR is unset', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { HOME: scratch, XDG_DATA_HOME: join(scratch, 'data') },
    });
    expect(root).toBe(join(scratch, 'data', 'ccsm', 'run'));
    expect(existsSync(root)).toBe(true);
  });

  it('falls back to <dataRoot>/run when XDG_RUNTIME_DIR is empty string', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '', HOME: scratch, XDG_DATA_HOME: join(scratch, 'data') },
    });
    expect(root).toBe(join(scratch, 'data', 'ccsm', 'run'));
  });

  it('falls back to <dataRoot>/run when XDG_RUNTIME_DIR points at a non-existent dir', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: {
        XDG_RUNTIME_DIR: join(scratch, 'does-not-exist'),
        HOME: scratch,
        XDG_DATA_HOME: join(scratch, 'data'),
      },
    });
    expect(root).toBe(join(scratch, 'data', 'ccsm', 'run'));
  });

  it('uses ~/.local/share/ccsm/run when neither XDG var is set', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { HOME: scratch },
      ensure: false,
    });
    // homedir() reads from process env on POSIX; not guaranteed to honor our
    // `env` arg. Assert the structural shape only.
    expect(root.endsWith(join('ccsm', 'run'))).toBe(true);
  });
});

describe('resolveRuntimeRoot — macOS', () => {
  it('returns <dataRoot>/run under ~/Library/Application Support/ccsm', () => {
    const root = resolveRuntimeRoot({
      platform: 'darwin',
      env: {},
      ensure: false,
    });
    const expectedSuffix = join('Library', 'Application Support', 'ccsm', 'run');
    expect(root.endsWith(expectedSuffix)).toBe(true);
    expect(root.startsWith(homedir())).toBe(true);
  });

  it('ignores XDG_RUNTIME_DIR on darwin (no XDG on macOS per spec)', () => {
    const xdg = join(scratch, 'xdg');
    mkdirSync(xdg, { recursive: true });
    const root = resolveRuntimeRoot({
      platform: 'darwin',
      env: { XDG_RUNTIME_DIR: xdg },
      ensure: false,
    });
    expect(root.includes(xdg)).toBe(false);
  });
});

describe('resolveRuntimeRoot — Windows', () => {
  it('returns %LOCALAPPDATA%\\ccsm\\run when LOCALAPPDATA is set', () => {
    const local = join(scratch, 'Local');
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: local },
    });
    expect(root).toBe(join(local, 'ccsm', 'run'));
    expect(existsSync(root)).toBe(true);
  });

  it('falls back to ~/AppData/Local/ccsm/run when LOCALAPPDATA is unset', () => {
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: {},
      ensure: false,
    });
    const expectedSuffix = ['AppData', 'Local', 'ccsm', 'run'].join(sep);
    expect(root.endsWith(expectedSuffix)).toBe(true);
  });

  it('does not throw when ensure=true creates a deep new path', () => {
    const local = join(scratch, 'fresh', 'Local');
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: local },
    });
    expect(existsSync(root)).toBe(true);
  });
});

describe('resolveRuntimeRoot — mkdir behavior', () => {
  it('creates the directory with mode 0o700 on POSIX', () => {
    const xdg = join(scratch, 'xdg2');
    mkdirSync(xdg, { recursive: true, mode: 0o700 });
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: xdg, HOME: scratch },
    });
    const st = statSync(root);
    expect(st.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      // mode bits aren't meaningful on Windows
      expect(st.mode & 0o777).toBe(0o700);
    }
  });

  it('is idempotent on re-call (no throw, same path)', () => {
    const local = join(scratch, 'idem');
    const env = { LOCALAPPDATA: local };
    const a = resolveRuntimeRoot({ platform: 'win32', env });
    const b = resolveRuntimeRoot({ platform: 'win32', env });
    const c = resolveRuntimeRoot({ platform: 'win32', env });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(existsSync(a)).toBe(true);
  });

  it('does not create the directory when ensure=false', () => {
    const local = join(scratch, 'noensure');
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: local },
      ensure: false,
    });
    expect(existsSync(root)).toBe(false);
  });
});

describe('userHash', () => {
  it('returns 8 lowercase hex chars', () => {
    const h = userHash({ username: 'alice', host: 'workstation' });
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(h.length).toBe(8);
  });

  it('is deterministic for the same (username, host)', () => {
    const a = userHash({ username: 'alice', host: 'workstation' });
    const b = userHash({ username: 'alice', host: 'workstation' });
    const c = userHash({ username: 'alice', host: 'workstation' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('produces distinct hashes for distinct usernames on the same host (anti-collision)', () => {
    const alice = userHash({ username: 'alice', host: 'shared-rds' });
    const bob = userHash({ username: 'bob', host: 'shared-rds' });
    expect(alice).not.toBe(bob);
  });

  it('produces distinct hashes for the same username on distinct hosts', () => {
    const home = userHash({ username: 'alice', host: 'home-pc' });
    const work = userHash({ username: 'alice', host: 'work-pc' });
    expect(home).not.toBe(work);
  });

  it('falls back to os.userInfo()/hostname() when called with no args', () => {
    const h = userHash();
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    // Same call twice — process identity is fixed for the test run.
    expect(userHash()).toBe(h);
  });

  // -------------------------------------------------------------------------
  // Dev-mode cwd-mix gate (B10 cross-worktree pipe collision fix). When
  // `env.CCSM_DAEMON_DEV === '1'` the seed folds in `cwd` so two dev daemons
  // spawned from different git worktrees on the same Windows host bind to
  // distinct named pipes. Production gate stays canonical so the packaged
  // installer keeps single-bind semantics across Electron restarts (frag-6-7
  // §6.1 dogfood metric #1).
  // -------------------------------------------------------------------------
  describe('CCSM_DAEMON_DEV cwd-mix gate', () => {
    it('production env: same (user, host) yields the same hash regardless of cwd', () => {
      const a = userHash({
        username: 'alice',
        host: 'workstation',
        cwd: '/repo/worktree-a',
        env: {},
      });
      const b = userHash({
        username: 'alice',
        host: 'workstation',
        cwd: '/repo/worktree-b',
        env: {},
      });
      expect(a).toBe(b);
    });

    it('dev env: same (user, host, cwd) yields the same hash (deterministic)', () => {
      const env = { CCSM_DAEMON_DEV: '1' };
      const a = userHash({ username: 'alice', host: 'host', cwd: '/a', env });
      const b = userHash({ username: 'alice', host: 'host', cwd: '/a', env });
      expect(a).toBe(b);
    });

    it('dev env: distinct cwds yield distinct hashes (per-worktree isolation)', () => {
      const env = { CCSM_DAEMON_DEV: '1' };
      const a = userHash({ username: 'alice', host: 'host', cwd: '/repo/pool-3', env });
      const b = userHash({ username: 'alice', host: 'host', cwd: '/repo/pool-5', env });
      expect(a).not.toBe(b);
    });

    it('dev hash differs from production hash for the same (user, host)', () => {
      const prod = userHash({ username: 'alice', host: 'host', cwd: '/x', env: {} });
      const dev = userHash({
        username: 'alice',
        host: 'host',
        cwd: '/x',
        env: { CCSM_DAEMON_DEV: '1' },
      });
      expect(dev).not.toBe(prod);
    });

    it('dev gate is strict on the literal "1" sentinel (does NOT fire on "true" / "0" / unset)', () => {
      const base = { username: 'alice', host: 'host', cwd: '/wt' };
      const prod = userHash({ ...base, env: {} });
      expect(userHash({ ...base, env: { CCSM_DAEMON_DEV: 'true' } })).toBe(prod);
      expect(userHash({ ...base, env: { CCSM_DAEMON_DEV: '0' } })).toBe(prod);
      expect(userHash({ ...base, env: { CCSM_DAEMON_DEV: '' } })).toBe(prod);
      expect(userHash({ ...base, env: { CCSM_DAEMON_DEV: '1' } })).not.toBe(prod);
    });

    it('falls back to process.cwd() when cwd opt is omitted (dev mode)', () => {
      const env = { CCSM_DAEMON_DEV: '1' };
      const explicit = userHash({
        username: 'alice',
        host: 'host',
        cwd: process.cwd(),
        env,
      });
      const implicit = userHash({ username: 'alice', host: 'host', env });
      expect(explicit).toBe(implicit);
    });
  });
});
