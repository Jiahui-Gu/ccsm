import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const dispatcherPath = path.resolve(__dirname, '..', 'scripts', 'after-sign.cjs');
const macPath = path.resolve(__dirname, '..', 'scripts', 'sign-macos.cjs');
const winPath = path.resolve(__dirname, '..', 'scripts', 'sign-windows.cjs');

function loadDispatcherWithMocks() {
  // Clear require cache so dispatcher and delegates are fresh per test.
  delete require.cache[dispatcherPath];
  delete require.cache[macPath];
  delete require.cache[winPath];

  const macSpy = vi.fn(async () => {});
  const winSpy = vi.fn(async () => {});

  // Pre-populate cache with mock modules so dispatcher's require() returns spies.
  require.cache[macPath] = {
    id: macPath,
    filename: macPath,
    loaded: true,
    exports: macSpy,
  } as any;
  require.cache[winPath] = {
    id: winPath,
    filename: winPath,
    loaded: true,
    exports: winSpy,
  } as any;

  const dispatcher = require(dispatcherPath);
  return { dispatcher, macSpy, winSpy };
}

describe('after-sign dispatcher', () => {
  beforeEach(() => {
    delete require.cache[dispatcherPath];
    delete require.cache[macPath];
    delete require.cache[winPath];
  });

  afterEach(() => {
    delete require.cache[dispatcherPath];
    delete require.cache[macPath];
    delete require.cache[winPath];
  });

  it('routes darwin to sign-macos only', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks();
    await dispatcher({ electronPlatformName: 'darwin' });
    expect(macSpy).toHaveBeenCalledTimes(1);
    expect(winSpy).not.toHaveBeenCalled();
  });

  it('routes win32 to sign-windows only', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks();
    await dispatcher({ electronPlatformName: 'win32' });
    expect(winSpy).toHaveBeenCalledTimes(1);
    expect(macSpy).not.toHaveBeenCalled();
  });

  it('no-op on linux', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks();
    await dispatcher({ electronPlatformName: 'linux' });
    expect(macSpy).not.toHaveBeenCalled();
    expect(winSpy).not.toHaveBeenCalled();
  });
});
