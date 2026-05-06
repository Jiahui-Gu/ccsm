// Unit tests for scripts/postinstall-helpers.mjs (Task #643).
//
// We don't spawn real `tasklist` / `pgrep` here — that would be flaky
// across machines (and dev's actual Electron PIDs would leak in). The
// helper accepts a `spawn` injection point precisely so tests can feed
// canned stdout/status combinations.

import { describe, it, expect } from 'vitest';

import {
  checkNoElectronRunning,
  formatBlockedMessage,
  parseTasklistCsvPids,
  parsePgrepPids,
} from '../scripts/postinstall-helpers.mjs';

// ---------------------------------------------------------------------
// CSV / pgrep parsers
// ---------------------------------------------------------------------

describe('parseTasklistCsvPids', () => {
  it('extracts PIDs from quoted CSV rows', () => {
    const out =
      '"electron.exe","12345","Console","1","123,456 K"\r\n' +
      '"electron.exe","67890","Console","1","45,000 K"\r\n';
    expect(parseTasklistCsvPids(out)).toEqual([12345, 67890]);
  });

  it('returns [] on the "no tasks" sentinel line', () => {
    expect(
      parseTasklistCsvPids('INFO: No tasks are running which match the specified criteria.\r\n'),
    ).toEqual([]);
  });

  it('returns [] on empty stdout', () => {
    expect(parseTasklistCsvPids('')).toEqual([]);
  });

  it('skips malformed rows without throwing', () => {
    const out =
      '"electron.exe","12345","Console","1","123,456 K"\r\n' +
      'garbage line\r\n' +
      '"electron.exe","not-a-number","Console","1","0 K"\r\n';
    expect(parseTasklistCsvPids(out)).toEqual([12345]);
  });
});

describe('parsePgrepPids', () => {
  it('parses one PID per line', () => {
    expect(parsePgrepPids('111\n222\n333\n')).toEqual([111, 222, 333]);
  });

  it('returns [] on empty stdout', () => {
    expect(parsePgrepPids('')).toEqual([]);
  });

  it('ignores blank and non-numeric lines', () => {
    expect(parsePgrepPids('111\n\nabc\n222\n')).toEqual([111, 222]);
  });
});

// ---------------------------------------------------------------------
// formatBlockedMessage
// ---------------------------------------------------------------------

describe('formatBlockedMessage', () => {
  it('lists all PIDs and references Task #643', () => {
    const msg = formatBlockedMessage([1234, 5678]);
    expect(msg).toContain('1234, 5678');
    expect(msg).toContain('Task #643');
    expect(msg).toContain('CCSM_POSTINSTALL_SKIP_PROCESS_CHECK=1');
  });

  it('handles empty PID list with "unknown" placeholder', () => {
    const msg = formatBlockedMessage([]);
    expect(msg).toContain('PIDs: unknown');
  });
});

// ---------------------------------------------------------------------
// checkNoElectronRunning — env override
// ---------------------------------------------------------------------

describe('checkNoElectronRunning — escape hatch', () => {
  it('returns { blocked: false, skipped: true } when env var set', () => {
    const result = checkNoElectronRunning({
      env: { CCSM_POSTINSTALL_SKIP_PROCESS_CHECK: '1' },
      // spawn shouldn't be called; if it is, blow up.
      spawn: () => {
        throw new Error('spawn should not be invoked when skip env is set');
      },
      platform: 'win32',
    });
    expect(result.blocked).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it('does NOT skip when env var has any other value', () => {
    let called = 0;
    checkNoElectronRunning({
      env: { CCSM_POSTINSTALL_SKIP_PROCESS_CHECK: '0' },
      spawn: () => {
        called += 1;
        return { status: 0, stdout: '', stderr: '', error: undefined };
      },
      platform: 'win32',
    });
    expect(called).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
// checkNoElectronRunning — Windows path
// ---------------------------------------------------------------------

describe('checkNoElectronRunning — Windows', () => {
  function fakeSpawn(scriptedResults) {
    let i = 0;
    return () => {
      const r = scriptedResults[i] ?? scriptedResults[scriptedResults.length - 1];
      i += 1;
      return r;
    };
  }

  it('returns blocked=true when tasklist reports an electron.exe', () => {
    const result = checkNoElectronRunning({
      platform: 'win32',
      env: {},
      spawn: fakeSpawn([
        // electron.exe call — one match
        {
          status: 0,
          stdout: '"electron.exe","4242","Console","1","123,456 K"\r\n',
          stderr: '',
        },
        // ccsm.exe call — no match
        {
          status: 0,
          stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
          stderr: '',
        },
      ]),
    });
    expect(result.blocked).toBe(true);
    expect(result.pids).toEqual([4242]);
    expect(result.message).toContain('4242');
  });

  it('returns blocked=true when tasklist reports a packaged ccsm.exe', () => {
    const result = checkNoElectronRunning({
      platform: 'win32',
      env: {},
      spawn: fakeSpawn([
        { status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n', stderr: '' },
        { status: 0, stdout: '"ccsm.exe","9999","Console","1","45,000 K"\r\n', stderr: '' },
      ]),
    });
    expect(result.blocked).toBe(true);
    expect(result.pids).toEqual([9999]);
  });

  it('returns blocked=false when neither name has matches', () => {
    const result = checkNoElectronRunning({
      platform: 'win32',
      env: {},
      spawn: fakeSpawn([
        { status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n', stderr: '' },
        { status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n', stderr: '' },
      ]),
    });
    expect(result.blocked).toBe(false);
  });

  it('does NOT block when tasklist itself fails to spawn', () => {
    const result = checkNoElectronRunning({
      platform: 'win32',
      env: {},
      spawn: () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' }),
    });
    expect(result.blocked).toBe(false);
  });

  it('dedupes overlapping PIDs across the two name probes', () => {
    const result = checkNoElectronRunning({
      platform: 'win32',
      env: {},
      spawn: fakeSpawn([
        { status: 0, stdout: '"electron.exe","555","Console","1","1 K"\r\n', stderr: '' },
        { status: 0, stdout: '"ccsm.exe","555","Console","1","1 K"\r\n', stderr: '' },
      ]),
    });
    expect(result.blocked).toBe(true);
    expect(result.pids).toEqual([555]);
  });
});

// ---------------------------------------------------------------------
// checkNoElectronRunning — Unix (macOS/Linux) path
// ---------------------------------------------------------------------

describe('checkNoElectronRunning — Unix', () => {
  function fakeSpawn(scriptedResults) {
    let i = 0;
    return () => {
      const r = scriptedResults[i] ?? scriptedResults[scriptedResults.length - 1];
      i += 1;
      return r;
    };
  }

  it('returns blocked=true when pgrep finds an electron-ccsm match (status 0)', () => {
    const result = checkNoElectronRunning({
      platform: 'darwin',
      env: {},
      spawn: fakeSpawn([
        { status: 0, stdout: '7777\n', stderr: '' }, // electron.*ccsm
        { status: 1, stdout: '', stderr: '' }, // ccsm$ — no match
      ]),
    });
    expect(result.blocked).toBe(true);
    expect(result.pids).toEqual([7777]);
  });

  it('returns blocked=false when pgrep returns status 1 for both patterns', () => {
    const result = checkNoElectronRunning({
      platform: 'linux',
      env: {},
      spawn: fakeSpawn([
        { status: 1, stdout: '', stderr: '' },
        { status: 1, stdout: '', stderr: '' },
      ]),
    });
    expect(result.blocked).toBe(false);
  });

  it('filters out the current process PID (false positive guard)', () => {
    const result = checkNoElectronRunning({
      platform: 'linux',
      env: {},
      spawn: fakeSpawn([
        { status: 0, stdout: `${process.pid}\n`, stderr: '' },
        { status: 1, stdout: '', stderr: '' },
      ]),
    });
    expect(result.blocked).toBe(false);
  });

  it('does NOT block when pgrep is missing (spawn error)', () => {
    const result = checkNoElectronRunning({
      platform: 'darwin',
      env: {},
      spawn: () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' }),
    });
    expect(result.blocked).toBe(false);
  });
});
