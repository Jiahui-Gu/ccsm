import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { openPathSafe, type ShellLike } from '../shell-open';

function makeShell(returnValue = '') {
  const openPath = vi.fn(async (_p: string) => returnValue);
  const shell: ShellLike = { openPath };
  return { shell, openPath };
}

const okFs = { access: async (_: string) => undefined };
const missingFs = {
  access: async (_: string) => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
};

describe('openPathSafe', () => {
  it('rejects non-string input as invalid_path', async () => {
    const { shell, openPath } = makeShell();
    expect(await openPathSafe(undefined, shell, okFs)).toEqual({
      ok: false,
      error: 'invalid_path',
    });
    expect(await openPathSafe(null, shell, okFs)).toEqual({
      ok: false,
      error: 'invalid_path',
    });
    expect(await openPathSafe(42, shell, okFs)).toEqual({
      ok: false,
      error: 'invalid_path',
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects empty string as invalid_path', async () => {
    const { shell, openPath } = makeShell();
    expect(await openPathSafe('', shell, okFs)).toEqual({
      ok: false,
      error: 'invalid_path',
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects relative paths as invalid_path', async () => {
    const { shell, openPath } = makeShell();
    expect(await openPathSafe('foo/bar', shell, okFs)).toEqual({
      ok: false,
      error: 'invalid_path',
    });
    expect(await openPathSafe('./repo', shell, okFs)).toEqual({
      ok: false,
      error: 'invalid_path',
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('returns not_found when the path does not exist', async () => {
    const { shell, openPath } = makeShell();
    const abs = path.join(os.tmpdir(), 'agentory-openpath-missing-' + Date.now());
    expect(await openPathSafe(abs, shell, missingFs)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('returns ok on a successful shell.openPath call', async () => {
    const { shell, openPath } = makeShell('');
    const abs = path.join(os.tmpdir(), 'agentory-openpath-ok');
    const res = await openPathSafe(abs, shell, okFs);
    expect(res).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(abs);
  });

  it('surfaces shell.openPath error string as open_failed/detail', async () => {
    const { shell } = makeShell('Failed to open');
    const abs = path.join(os.tmpdir(), 'agentory-openpath-fail');
    const res = await openPathSafe(abs, shell, okFs);
    expect(res).toEqual({
      ok: false,
      error: 'open_failed',
      detail: 'Failed to open',
    });
  });
});
