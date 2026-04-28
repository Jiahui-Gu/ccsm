// Resolve the absolute path of the bundled ttyd binary.
//
// IMPORTANT: ttyd binary must be the MSVC build (currently djdarcy's
// fork, https://github.com/djdarcy/ttyd-msvc/releases/tag/1.7.7-msvc1).
// The upstream MinGW-W64 cross-compiled ttyd 1.7.7 binary hits a
// ConPTY CreateProcessW error 123 on Windows 11 25H2+ and the ttyd
// process access-violations (0xC0000005) the moment a client connects.
// See:
//   - https://github.com/tsl0922/ttyd/issues/1501
//   - https://github.com/tsl0922/ttyd/pull/1502 (merged upstream, no
//     release yet)
// The MSVC build is dynamically linked, so the runtime DLLs
// (uv.dll, websockets.dll, libcrypto-3-x64.dll, libssl-3-x64.dll,
// json-c.dll, zlib1.dll, getopt.dll) MUST sit next to ttyd.exe in
// both the dev directory and the packaged resources/. Once ttyd cuts
// a release that includes an MSVC build, switch back to the upstream
// binary and drop the DLL bundle.
//
// Dev (app.isPackaged === false): we read from the spike's bin directory
// (`<repo>/spike/ttyd-embed/bin/ttyd.exe`). The spike location is
// intentional for now — Worker 4's packaging follow-up may relocate the
// dev source under `electron/cliBridge/bin/` once we settle on a layout,
// but moving it twice churns the diff for no functional gain. The dev
// path is computed relative to the compiled main.js (`dist/electron/`),
// so going up two directories lands at the repo root.
//
// Prod (app.isPackaged === true): electron-builder's `extraResources`
// drops ttyd.exe at `process.resourcesPath/ttyd.exe`. See
// `package.json` `build.extraResources` (commit 5 of this PR).
//
// Platform scope: Windows-only for MVP. macOS/Linux ttyd binaries will
// be added when we ship those installers. Returning null on unsupported
// platforms lets the renderer surface a clean "ttyd not bundled for your
// OS" message instead of crashing on a missing-file spawn.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app } from 'electron';

export function ttydBinaryPath(): string | null {
  if (process.platform !== 'win32') return null;

  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'ttyd.exe');
    return fs.existsSync(p) ? p : null;
  }

  // dist/electron/cliBridge/ttydBinary.js  →  ../../../  →  repo root
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const p = path.join(repoRoot, 'spike', 'ttyd-embed', 'bin', 'ttyd.exe');
  return fs.existsSync(p) ? p : null;
}
