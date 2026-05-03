import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock `electron` before importing the SUT so the `shell` import resolves to
// our spy. vitest hoists `vi.mock` above imports automatically.
const openExternal = vi.fn(async (_url: string) => {});
vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => openExternal(url),
  },
}));

import { safeOpenUrl, isSafeUrl, UnsafeUrlError } from '../safeOpenUrl';

beforeEach(() => {
  openExternal.mockClear();
});

describe('isSafeUrl', () => {
  it('accepts https://', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
  });
  it('accepts http://', () => {
    expect(isSafeUrl('http://example.com/path?q=1#frag')).toBe(true);
  });
  it('rejects file://', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });
  it('rejects javascript:', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });
  it('rejects custom schemes', () => {
    expect(isSafeUrl('vscode://settings')).toBe(false);
    expect(isSafeUrl('slack://open')).toBe(false);
    expect(isSafeUrl('mailto:a@b.com')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>1</script>')).toBe(false);
  });
  it('rejects malformed URLs', () => {
    expect(isSafeUrl('not a url')).toBe(false);
    expect(isSafeUrl('://broken')).toBe(false);
  });
  it('rejects empty / non-string', () => {
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl(42)).toBe(false);
    expect(isSafeUrl({})).toBe(false);
  });
  it('is case-insensitive on the scheme (URL parser normalizes)', () => {
    expect(isSafeUrl('HTTPS://example.com')).toBe(true);
    expect(isSafeUrl('Http://example.com')).toBe(true);
  });
});

describe('safeOpenUrl', () => {
  it('forwards https:// URLs to shell.openExternal', async () => {
    await safeOpenUrl('https://example.com/');
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('forwards http:// URLs to shell.openExternal', async () => {
    await safeOpenUrl('http://example.com/path');
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('http://example.com/path');
  });

  it('rejects file:// without calling shell.openExternal', async () => {
    await expect(safeOpenUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects javascript: without calling shell.openExternal', async () => {
    await expect(safeOpenUrl('javascript:alert(1)')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects custom schemes (vscode://, slack://, mailto:)', async () => {
    for (const url of ['vscode://settings', 'slack://open', 'mailto:a@b.com']) {
      openExternal.mockClear();
      await expect(safeOpenUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it('rejects data: URLs', async () => {
    await expect(safeOpenUrl('data:text/html,<script>1</script>')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs', async () => {
    await expect(safeOpenUrl('not a url')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects empty string', async () => {
    await expect(safeOpenUrl('')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects non-string inputs', async () => {
    for (const v of [undefined, null, 42, {}, []]) {
      openExternal.mockClear();
      await expect(safeOpenUrl(v as unknown)).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it('UnsafeUrlError exposes url + scheme for callers', async () => {
    try {
      await safeOpenUrl('vscode://settings');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeUrlError);
      const err = e as UnsafeUrlError;
      expect(err.url).toBe('vscode://settings');
      expect(err.scheme).toBe('vscode:');
      expect(err.name).toBe('UnsafeUrlError');
    }
  });

  it('propagates shell.openExternal rejections unchanged', async () => {
    openExternal.mockRejectedValueOnce(new Error('boom'));
    await expect(safeOpenUrl('https://example.com')).rejects.toThrow('boom');
  });
});
