// electron-builder afterPack hook.
//
// Verify the bundled `ttyd.exe` binary actually landed in
// `<resources>/ttyd.exe`. CCSM's right pane is a ttyd-served terminal
// (PR: cliBridge + ttyd refactor); shipping an installer with no ttyd
// means every session-open call returns `ttyd_binary_missing` and the
// app is dead in the water. A typo in `extraResources` or a missing
// source file is otherwise a silent failure surfaced only on first
// session open — turn it into a hard build failure here.
//
// We intentionally do NOT verify the user's `claude` CLI: it is no
// longer bundled by ccsm (the in-process SDK runner that required it
// was deleted), the user's installed CLI on PATH is what cliBridge
// resolves at runtime via `where claude.cmd`. The runtime resolver
// already returns a clean `claude_not_found` error to the renderer.
//
// Scope: win32-x64 ships ttyd.exe today. Other platforms are a no-op
// until we add their ttyd binaries. Local dev runs for unsupported
// platforms shouldn't fail builds for an orthogonal reason.

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  // electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64
  const archName = ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' })[arch] ?? String(arch);

  // Only win32-x64 ships ttyd today. mac/linux are a no-op until those
  // ttyd binaries are added to extraResources in a follow-up PR.
  const platformKey = `${electronPlatformName}-${archName}`;
  if (platformKey !== 'win32-x64') {
    console.log(`[after-pack] Skipping ttyd verify for ${platformKey} (no bundled binary yet).`);
    return;
  }

  // On macOS, appOutDir is e.g. release/mac and resources live inside
  // the .app bundle at CCSM.app/Contents/Resources/. On Windows/Linux,
  // resources are directly at appOutDir/resources/. Win-only here, but
  // keep the branch so a future macOS ttyd ship can drop in cleanly.
  let resourcesDir;
  if (electronPlatformName === 'darwin') {
    const appBundle = fs
      .readdirSync(appOutDir)
      .find((name) => name.endsWith('.app'));
    if (!appBundle) {
      throw new Error(`[after-pack] No .app bundle found in ${appOutDir}`);
    }
    resourcesDir = path.join(appOutDir, appBundle, 'Contents', 'Resources');
  } else {
    resourcesDir = path.join(appOutDir, 'resources');
  }

  const ttydPath = path.join(resourcesDir, 'ttyd.exe');
  if (!fs.existsSync(ttydPath)) {
    let listing = '<missing>';
    try {
      listing = fs.readdirSync(resourcesDir).join(', ') || '<empty>';
    } catch {
      // resourcesDir may not exist at all
    }
    throw new Error(
      `[after-pack] Expected ttyd binary at:\n  - ${ttydPath}\n` +
        `  but it does not exist on disk.\n` +
        `  resources contents: ${listing}\n` +
        `Hint: check that build.extraResources contains an entry mapping ` +
        `spike/ttyd-embed/bin/ttyd.exe → ttyd.exe.`,
    );
  }

  const sizeMB = (fs.statSync(ttydPath).size / 1024 / 1024).toFixed(1);
  console.log(`[after-pack] OK ${platformKey}: ttyd.exe present (${sizeMB} MB) at ${ttydPath}`);
};
