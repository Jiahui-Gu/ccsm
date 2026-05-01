'use strict';
// Dispatcher: routes electron-builder afterSign to platform-specific signing scripts.
// Each delegate platform-gates internally and is no-op on the wrong platform.
const path = require('path');
module.exports = async function afterSign(context) {
  const platform = context.electronPlatformName;
  if (platform === 'darwin' || platform === 'mas') {
    // sign-macos.cjs uses `exports.signMacApp` / `exports.default` rather
    // than `module.exports = fn`, so the bare module is `{ signMacApp,
    // default, ... }` — pick the named export.
    const signMac = require(path.join(__dirname, 'sign-macos.cjs')).signMacApp;
    await signMac(context);
  }
  if (platform === 'win32') {
    const signWin = require(path.join(__dirname, 'sign-windows.cjs'));
    await signWin(context);
  }
  // Linux: no signing, no-op
};
