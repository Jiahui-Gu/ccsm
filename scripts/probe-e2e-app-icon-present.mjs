// Verify the packaged app icon asset is present, non-trivial, and a valid
// PNG. This is the lightweight "catch accidental deletion" regression
// guard — it does NOT boot Electron. Rationale: on Windows the BrowserWindow
// icon path is flaky across environments (electron-builder converts
// build/icon.png to .ico at package time; `getIcon()` on an unpackaged
// runtime is usually empty). Checking the source asset is the test that
// actually fails when someone rm's it.
//
// If the icon ever regresses, run `node scripts/generate-app-icon.mjs`.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const iconPath = path.join(root, 'build', 'icon.png');

function fail(msg) {
  console.error(`\n[probe-e2e-app-icon-present] FAIL: ${msg}`);
  process.exit(1);
}

let st;
try {
  st = await stat(iconPath);
} catch (e) {
  fail(`build/icon.png not found at ${iconPath} — run: node scripts/generate-app-icon.mjs`);
}

if (!st.isFile()) fail(`${iconPath} is not a regular file`);
if (st.size < 1024) fail(`build/icon.png is suspiciously small (${st.size} bytes; expected > 1 KiB)`);

const buf = await readFile(iconPath);
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!buf.subarray(0, 8).equals(pngMagic)) {
  fail('build/icon.png does not start with the PNG signature');
}

// IHDR lives at bytes 8..32; width/height are 4-byte big-endian ints at offsets 16 and 20.
const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
if (width < 256 || height < 256) {
  fail(`icon dimensions ${width}x${height} are below the 256x256 minimum electron-builder expects for win/mac conversion`);
}

console.log(`[probe-e2e-app-icon-present] OK: ${iconPath} (${st.size} bytes, ${width}x${height})`);
