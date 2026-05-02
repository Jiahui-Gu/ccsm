'use strict';
// Dispatcher: routes electron-builder afterSign to platform-specific signing scripts.
// Each delegate platform-gates internally and is no-op on the wrong platform.
//
// Export-shape resilience: sign-macos.cjs / sign-windows.cjs are CommonJS but
// historically used inconsistent export shapes. sign-macos.cjs in particular
// only exports an OBJECT (`exports.signMacApp = ...; exports.default = ...`),
// so `require(...)` returns an object — calling it directly throws
// `TypeError: signMac is not a function` on real darwin signed builds. The UTs
// previously masked this by pre-populating `require.cache[...].exports = spy`
// with a bare function. We resolve to a callable across all three shapes:
//   1) named export `signMacApp` / `signWindowsHook` (preferred for new code)
//   2) `default` export (ESM-interop convention)
//   3) the module itself if it IS a function (legacy bare-fn shape)
const path = require('path');

function resolveCallable(mod, namedExport) {
  if (mod && typeof mod[namedExport] === 'function') return mod[namedExport];
  if (mod && typeof mod.default === 'function') return mod.default;
  if (typeof mod === 'function') return mod;
  throw new TypeError(
    `[after-sign] could not resolve callable from module; ` +
      `expected named export "${namedExport}", "default", or a function ` +
      `(got ${mod === null ? 'null' : typeof mod})`,
  );
}

module.exports = async function afterSign(context) {
  const platform = context.electronPlatformName;
  if (platform === 'darwin' || platform === 'mas') {
    const mod = require(path.join(__dirname, 'sign-macos.cjs'));
    const signMac = resolveCallable(mod, 'signMacApp');
    await signMac(context);
  }
  if (platform === 'win32') {
    const mod = require(path.join(__dirname, 'sign-windows.cjs'));
    const signWin = resolveCallable(mod, 'signWindowsHook');
    await signWin(context);
  }
  // Linux: no signing, no-op
};

module.exports.resolveCallable = resolveCallable;
