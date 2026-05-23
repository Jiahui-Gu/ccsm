// Copy non-TS assets the V2 mobile remote host needs (the hidden BrowserWindow
// HTML) into `dist/electron/remote/`. Runs from `npm run build` before
// electron-builder packages the app.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'electron', 'remote', 'mobileRemoteHostPage.html');
const dst = path.join(__dirname, '..', 'dist', 'electron', 'remote', 'mobileRemoteHostPage.html');

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('[copy-remote-assets] copied', src, '->', dst);
