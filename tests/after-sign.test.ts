import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const dispatcherPath = path.resolve(__dirname, '..', 'scripts', 'after-sign.cjs');
const macPath = path.resolve(__dirname, '..', 'scripts', 'sign-macos.cjs');
const winPath = path.resolve(__dirname, '..', 'scripts', 'sign-windows.cjs');

type ExportShape =
  | 'bare-fn' // module.exports = fn (legacy)
  | 'named' // module.exports = { signMacApp: fn, signWindowsHook: fn }
  | 'default'; // module.exports = { default: fn }

function buildExports(spy: ReturnType<typeof vi.fn>, shape: ExportShape, namedKey: string) {
  switch (shape) {
    case 'bare-fn':
      return spy;
    case 'named':
      return { [namedKey]: spy };
    case 'default':
      return { default: spy };
  }
}

function loadDispatcherWithMocks(opts?: { macShape?: ExportShape; winShape?: ExportShape }) {
  const macShape: ExportShape = opts?.macShape ?? 'bare-fn';
  const winShape: ExportShape = opts?.winShape ?? 'bare-fn';

  // Clear require cache so dispatcher and delegates are fresh per test.
  delete require.cache[dispatcherPath];
  delete require.cache[macPath];
  delete require.cache[winPath];

  const macSpy = vi.fn(async () => {});
  const winSpy = vi.fn(async () => {});

  // Pre-populate cache with mock modules so dispatcher's require() returns our shape.
  require.cache[macPath] = {
    id: macPath,
    filename: macPath,
    loaded: true,
    exports: buildExports(macSpy, macShape, 'signMacApp'),
  } as any;
  require.cache[winPath] = {
    id: winPath,
    filename: winPath,
    loaded: true,
    exports: buildExports(winSpy, winShape, 'signWindowsHook'),
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

  // Export-shape coverage — production sign-macos.cjs uses the named-export shape,
  // which the previous dispatcher did not handle (TypeError on real darwin sign).
  // Each test below pins one branch of the resolveCallable() fallback chain.

  it('darwin: resolves named export shape (sign-macos.cjs production shape)', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks({ macShape: 'named' });
    await dispatcher({ electronPlatformName: 'darwin' });
    expect(macSpy).toHaveBeenCalledTimes(1);
    expect(winSpy).not.toHaveBeenCalled();
  });

  it('darwin: resolves default export shape (ESM-interop)', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks({ macShape: 'default' });
    await dispatcher({ electronPlatformName: 'darwin' });
    expect(macSpy).toHaveBeenCalledTimes(1);
    expect(winSpy).not.toHaveBeenCalled();
  });

  it('darwin: resolves bare-fn export shape (legacy)', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks({ macShape: 'bare-fn' });
    await dispatcher({ electronPlatformName: 'darwin' });
    expect(macSpy).toHaveBeenCalledTimes(1);
    expect(winSpy).not.toHaveBeenCalled();
  });

  it('win32: resolves named export shape', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks({ winShape: 'named' });
    await dispatcher({ electronPlatformName: 'win32' });
    expect(winSpy).toHaveBeenCalledTimes(1);
    expect(macSpy).not.toHaveBeenCalled();
  });

  it('win32: resolves default export shape', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks({ winShape: 'default' });
    await dispatcher({ electronPlatformName: 'win32' });
    expect(winSpy).toHaveBeenCalledTimes(1);
    expect(macSpy).not.toHaveBeenCalled();
  });

  it('win32: resolves bare-fn export shape (sign-windows.cjs production shape)', async () => {
    const { dispatcher, macSpy, winSpy } = loadDispatcherWithMocks({ winShape: 'bare-fn' });
    await dispatcher({ electronPlatformName: 'win32' });
    expect(winSpy).toHaveBeenCalledTimes(1);
    expect(macSpy).not.toHaveBeenCalled();
  });
});
