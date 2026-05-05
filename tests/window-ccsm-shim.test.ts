// Regression test for Task #602 (PR-1, spec #592 T-1) — the wave-1-C
// shim's daemon path names had drifted from the wave-2-A daemon router
// registrations (audit doc: docs/audit/2026-05-06-ccsm-loadstate-removal.md).
//
// What we lock in here:
//   1. loadState  → POST /api/db/load            (was /api/loadState, 404)
//   2. saveState  → POST /api/db/save            (was /api/saveState, 404)
//   3. userCwds.* → POST /api/app/userCwds/{op}  (was /api/userCwds/*,  404)
//   4. saveState's daemon response is `{ ok: true } | { ok: false; error }`;
//      the shim must unwrap-and-throw on `ok: false` so persist failures
//      surface to the caller (v0.2 contract). The previous `m<void>`
//      generic dropped the discriminant on the floor → silent data loss.
//
// We mock daemon-client so the test never touches a real socket — purely
// asserts the static path map + the saveState error branch.

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../src/lib/daemon-client', () => ({
  daemonInvoke: vi.fn(),
  daemonEvent: vi.fn(),
}));

vi.mock('../src/lib/daemon-port', () => ({
  init: vi.fn(async () => undefined),
  getDaemonPort: vi.fn(async () => 12345),
}));

import { daemonInvoke } from '../src/lib/daemon-client';
import { installCcsmShim } from '../src/lib/window-ccsm-shim';

const mockedInvoke = daemonInvoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  // installCcsmShim pre-fetches `window/platform` during boot; default
  // every call to a benign value, individual tests override per case.
  mockedInvoke.mockResolvedValue(null);
  // Clear any previously installed shim so installCcsmShim can redefine
  // window.ccsm (it's installed non-enumerable + non-writable; we have to
  // explicitly delete the property to overwrite cleanly between tests).
  // configurable: true on the property descriptor makes this safe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).ccsm;
});

async function install(): Promise<void> {
  await installCcsmShim();
  // Drop the boot-time `window/platform` call so per-test assertions only
  // see the calls the test itself triggers.
  mockedInvoke.mockClear();
}

describe('window-ccsm-shim daemon path map', () => {
  it('loadState calls /api/db/load with the key arg', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce('cached-value');
    const result = await window.ccsm.loadState('appearance');
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith('db/load', ['appearance']);
    expect(result).toBe('cached-value');
  });

  it('saveState calls /api/db/save with key + value args', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce({ ok: true });
    await window.ccsm.saveState('appearance', '{"theme":"dark"}');
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith('db/save', [
      'appearance',
      '{"theme":"dark"}',
    ]);
  });

  it('userCwds.get calls /api/app/userCwds/get', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce(['/tmp/a', '/tmp/b']);
    const result = await window.ccsm.userCwds.get();
    expect(mockedInvoke).toHaveBeenCalledWith('app/userCwds/get', []);
    expect(result).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('userCwds.push calls /api/app/userCwds/push with the path arg', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce(['/tmp/new']);
    const result = await window.ccsm.userCwds.push('/tmp/new');
    expect(mockedInvoke).toHaveBeenCalledWith('app/userCwds/push', ['/tmp/new']);
    expect(result).toEqual(['/tmp/new']);
  });
});

describe('window-ccsm-shim saveState unwrap-throw', () => {
  it('throws with the daemon error message when response is { ok: false, error }', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce({ ok: false, error: 'value_too_large' });
    await expect(
      window.ccsm.saveState('appearance', 'x'.repeat(10_000_000)),
    ).rejects.toThrow('value_too_large');
  });

  it('throws a generic message when response is { ok: false } with no error string', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce({ ok: false });
    await expect(window.ccsm.saveState('k', 'v')).rejects.toThrow('saveState failed');
  });

  it('throws when response is missing / null (defensive: bad daemon envelope)', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce(null);
    await expect(window.ccsm.saveState('k', 'v')).rejects.toThrow('saveState failed');
  });

  it('resolves silently on { ok: true }', async () => {
    await install();
    mockedInvoke.mockResolvedValueOnce({ ok: true });
    await expect(window.ccsm.saveState('k', 'v')).resolves.toBeUndefined();
  });
});
