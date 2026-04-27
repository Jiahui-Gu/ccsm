// Resolve the absolute path of the bundled ttyd binary.
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
