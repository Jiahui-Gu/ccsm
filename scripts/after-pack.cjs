// electron-builder afterPack hook.
//
// Verify the node-pty native binding actually landed in the packaged
// app's asar.unpacked tree. CCSM's right pane is an in-process node-pty
// + xterm.js terminal (post-PR-8 direct-xterm refactor); shipping an
// installer with no node-pty native means every pty:spawn IPC throws
// `Cannot find module 'pty.node'` and the app is dead in the water.
//
// A typo in `asarUnpack`, a failed electron-rebuild during install, or
// a missing prebuild fallback is otherwise a silent failure surfaced
// only on first session open — turn it into a hard build failure here.
//
// We accept either path because node-pty 1.x ships in two flavors at
// runtime depending on whether electron-rebuild succeeded:
//   - rebuilt :  build/Release/pty.node
//   - prebuild:  prebuilds/<platform>-<arch>/pty.node
//
// We intentionally do NOT verify the user's `claude` CLI: it is not
// bundled (the user installs it via npm), and the runtime resolver in
// electron/ptyHost/claudeResolver.ts surfaces a clean `claude_not_found`
// error to the renderer when missing.

const fs = require('node:fs');
const path = require('node:path');
const requiredAfterPack = require('./required-after-pack.cjs');

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  // electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64
  const archName = ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' })[arch] ?? String(arch);
  const platformKey = `${electronPlatformName}-${archName}`;

  // On macOS, appOutDir is e.g. release/mac and resources live inside
  // the .app bundle at CCSM.app/Contents/Resources/. On Windows/Linux,
  // resources are directly at appOutDir/resources/.
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

  const ptyRoot = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty');
  const rebuiltBinding = path.join(ptyRoot, 'build', 'Release', 'pty.node');

  // Map electron-builder platform/arch onto node-pty's prebuild dir name.
  // Schema: <os>-<arch> with os ∈ {win32,darwin,linux} and arch ∈
  // {x64,arm64,ia32}. node-pty's prebuilds layout matches this directly.
  const prebuildKey = `${electronPlatformName}-${archName}`;
  const prebuiltBinding = path.join(
    ptyRoot,
    'prebuilds',
    prebuildKey,
    'pty.node',
  );

  const haveRebuilt = fs.existsSync(rebuiltBinding);
  const havePrebuilt = fs.existsSync(prebuiltBinding);

  if (!haveRebuilt && !havePrebuilt) {
    let listing = '<missing>';
    try {
      listing = fs.readdirSync(ptyRoot).join(', ') || '<empty>';
    } catch {
      // ptyRoot may not exist at all (asarUnpack typo etc.)
    }
    throw new Error(
      `[after-pack] node-pty native binding missing for ${platformKey}.\n` +
        `  Looked for:\n` +
        `    rebuilt:  ${rebuiltBinding}\n` +
        `    prebuilt: ${prebuiltBinding}\n` +
        `  node-pty contents: ${listing}\n` +
        `Hint: confirm \`npm install\` ran electron-rebuild for node-pty, ` +
        `or that the prebuild for ${prebuildKey} ships in the published ` +
        `node-pty tarball. Check build.asarUnpack in package.json includes ` +
        `**/node_modules/node-pty/**.`,
    );
  }

  const which = haveRebuilt ? rebuiltBinding : prebuiltBinding;
  const sizeKB = (fs.statSync(which).size / 1024).toFixed(0);
  const flavor = haveRebuilt ? 'rebuilt' : 'prebuilt';
  console.log(
    `[after-pack] OK ${platformKey}: node-pty ${flavor} binding present (${sizeKB} KB) at ${which}`,
  );

  // T57 (#1012) — REQUIRED_AFTER_PACK validation: every daemon-runtime file
  // (binary, natives, SDK, Win uninstall helper) must be present in BOTH
  // the extraResources stage AND the asarUnpack stage. Throws on missing.
  await requiredAfterPack.validate(context);
};
