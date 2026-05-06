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

  // ───────── better-sqlite3 native binding (Task #641 Layer 2) ──────────
  // Same contract as node-pty above, but for better-sqlite3. The dogfood
  // #575 root cause was a postinstall electron-rebuild failure that left
  // better-sqlite3 compiled against the host Node ABI; the runtime daemon
  // then crashed on first DB open with `NODE_MODULE_VERSION mismatch`.
  // Failing the build here turns "user gets a silent storage failure on
  // first launch" into "the install isn't published in the first place".
  //
  // better-sqlite3 does NOT ship cross-platform prebuilds the same way
  // node-pty does — its npm tarball includes a single rebuilt binding for
  // the install host, which the postinstall step (scripts/postinstall.mjs)
  // re-targets to the Electron ABI. So we only check the rebuilt path.
  const sqliteRoot = path.join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
  );
  const sqliteBinding = path.join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(sqliteBinding)) {
    let listing = '<missing>';
    try {
      listing = fs.readdirSync(sqliteRoot).join(', ') || '<empty>';
    } catch {
      // sqliteRoot may not exist at all (asarUnpack typo etc.)
    }
    throw new Error(
      `[after-pack] better-sqlite3 native binding missing for ${platformKey}.\n` +
        `  Looked for: ${sqliteBinding}\n` +
        `  better-sqlite3 contents: ${listing}\n` +
        `Hint: confirm \`npm install\` ran the postinstall hook (scripts/postinstall.mjs) ` +
        `which invokes @electron/rebuild for better-sqlite3. Without this binding the ` +
        `daemon fails to open the SQLite DB and the app shows a silent storage failure ` +
        `on first launch (Task #575 / #641). Check build.asarUnpack in package.json ` +
        `includes **/node_modules/better-sqlite3/**.`,
    );
  }
  const sqliteSizeKB = (fs.statSync(sqliteBinding).size / 1024).toFixed(0);
  console.log(
    `[after-pack] OK ${platformKey}: better-sqlite3 binding present (${sqliteSizeKB} KB) at ${sqliteBinding}`,
  );
};
