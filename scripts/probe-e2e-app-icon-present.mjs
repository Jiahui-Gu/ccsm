// Verify the packaged app icon asset is present, non-trivial, a valid PNG,
// AND wired into electron-builder for every shipped platform.
//
// Why a file/config check, not an Electron runtime probe?
//   On Windows the BrowserWindow icon path is FLAKY across environments —
//   electron-builder converts `build/icon.png` to `.ico` at package time and
//   bakes it into the .exe resource table; `BrowserWindow.getIcon()` on an
//   unpackaged dev runtime is usually empty, and Windows shell icon caching
//   means even a packaged-build runtime check can return a stale icon for
//   minutes after install. A booted-Electron probe here would either:
//     (a) hit asar resolution differences between dev and prod and false-fail,
//     (b) race against icon-load and false-fail, or
//     (c) get cached-shell results and false-pass.
//   The actual regression we want to catch is "someone deleted build/icon.png
//   or unwired it from the platform-specific build config" — both are pure
//   filesystem/JSON checks that need zero windowing system. Per
//   feedback_correctness_over_cost.md we REPLACED the Electron runtime probe
//   (#247: was flaky on Windows) with these deterministic checks rather than
//   skipping or marking flaky.
//
// Coverage:
//   1. build/icon.png exists, is a real file, > 1 KiB.
//   2. PNG signature is valid.
//   3. IHDR width/height are >= 256 (electron-builder's minimum for win/mac
//      .ico/.icns conversion).
//   4. package.json `build.{win,mac,linux}.icon` all reference an existing
//      file under repo root (catches the "icon present but unwired in
//      electron-builder config" regression that #247's runtime probe was
//      trying — and failing — to catch).
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

// (#247) Verify electron-builder is actually pointed at build/icon.png for
// every platform we ship. A correct PNG that nobody references in the build
// config produces a packaged app with the default Electron icon — exactly
// the regression the original runtime probe tried to catch but couldn't
// reliably observe on Windows.
const pkgRaw = await readFile(path.join(root, 'package.json'), 'utf8');
let pkg;
try {
  pkg = JSON.parse(pkgRaw);
} catch (e) {
  fail(`package.json is not valid JSON: ${e.message}`);
}

const build = pkg && pkg.build;
if (!build || typeof build !== 'object') {
  fail('package.json missing top-level "build" object (electron-builder config)');
}

for (const platform of ['win', 'mac', 'linux']) {
  const cfg = build[platform];
  if (!cfg || typeof cfg !== 'object') {
    fail(`package.json build.${platform} missing — electron-builder won't package an icon for ${platform}`);
  }
  const ref = cfg.icon;
  if (typeof ref !== 'string' || ref.length === 0) {
    fail(`package.json build.${platform}.icon is not set; ${platform} build will use Electron's default icon`);
  }
  const abs = path.resolve(root, ref);
  let refSt;
  try {
    refSt = await stat(abs);
  } catch (e) {
    fail(`package.json build.${platform}.icon points at "${ref}" but ${abs} does not exist`);
  }
  if (!refSt.isFile()) {
    fail(`package.json build.${platform}.icon "${ref}" resolves to ${abs} which is not a regular file`);
  }
}

console.log(
  `[probe-e2e-app-icon-present] OK: ${iconPath} (${st.size} bytes, ${width}x${height})` +
    `; build.{win,mac,linux}.icon all wired and resolvable`
);
