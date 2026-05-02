// Task #152 — regression guard for build/linux-postrm.sh DAEMON_BIN_PATH.
//
// PR #810 (task #133, frag-11 §11.6.3) shipped a postrm with hardcoded
//   DAEMON_BIN_PATH="/usr/lib/ccsm/resources/daemon/ccsm-daemon"
// The actual electron-builder linux install layout (verified against
// app-builder-lib/out/targets/{LinuxTargetHelper,FpmTarget}.js) is:
//   - installPrefix = "/opt"  (LinuxTargetHelper.js)
//   - app root      = `${installPrefix}/${appInfo.sanitizedProductName}`
//   - sanitizedProductName preserves casing (sanitizeFileName only strips
//     path-unsafe chars, does NOT lowercase)
//   - extraResources land under `<appRoot>/resources/...`
// For package.json `build.productName = "CCSM"` the linux extraResources entry
//   { from: "daemon/dist/ccsm-daemon-staged", to: "daemon/ccsm-daemon" }
// produces the on-disk path `/opt/CCSM/resources/daemon/ccsm-daemon`.
//
// The pkill -f fallback in the postrm requires the matched argv prefix to
// equal the real install path; a stale path silently breaks the daemon-stop
// fallback (no error, just an orphan daemon on uninstall).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..');

interface PkgBuildLinuxExtra {
  from: string;
  to: string;
}

interface PkgJson {
  build: {
    productName: string;
    deb?: { afterRemove?: string };
    rpm?: { afterRemove?: string };
    linux?: { extraResources?: PkgBuildLinuxExtra[] };
  };
}

function loadPkg(): PkgJson {
  return JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ) as PkgJson;
}

function readPostrm(): string {
  return readFileSync(join(repoRoot, 'build', 'linux-postrm.sh'), 'utf8');
}

// Mirror app-builder-lib's filename sanitizer just enough for our productName
// values. The full implementation strips characters from a denylist; "CCSM"
// is already safe, but we keep the helper so future renames break loudly.
function sanitizedProductName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_');
}

describe('linux-postrm DAEMON_BIN_PATH (task #152)', () => {
  it('matches the electron-builder linux install path derived from package.json', () => {
    const pkg = loadPkg();
    const productName = pkg.build.productName;
    expect(productName).toBeTruthy();

    const linuxExtra = pkg.build.linux?.extraResources ?? [];
    const daemonEntry = linuxExtra.find((e) => e.to === 'daemon/ccsm-daemon');
    expect(
      daemonEntry,
      'package.json build.linux.extraResources must map daemon binary to daemon/ccsm-daemon',
    ).toBeDefined();

    const expected = `/opt/${sanitizedProductName(productName)}/resources/${daemonEntry!.to}`;

    const postrm = readPostrm();
    const m = postrm.match(/^DAEMON_BIN_PATH="([^"]+)"/m);
    expect(m, 'build/linux-postrm.sh must define DAEMON_BIN_PATH').not.toBeNull();
    expect(m![1]).toBe(expected);
  });

  it('is wired into both deb and rpm afterRemove hooks', () => {
    const pkg = loadPkg();
    expect(pkg.build.deb?.afterRemove).toBe('build/linux-postrm.sh');
    expect(pkg.build.rpm?.afterRemove).toBe('build/linux-postrm.sh');
  });

  it('does not regress to the legacy /usr/lib/ccsm/ path', () => {
    // Sentinel: the original PR #810 path. If this string ever reappears in
    // the script the test fails loudly with task context.
    const postrm = readPostrm();
    expect(postrm).not.toMatch(/\/usr\/lib\/ccsm\/resources\/daemon\/ccsm-daemon/);
  });
});
