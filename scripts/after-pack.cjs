// electron-builder afterPack hook.
//
// Verify the @anthropic-ai/claude-agent-sdk-<platform-arch>/claude[.exe]
// binary actually landed inside app.asar.unpacked. Shipping an installer
// with no CLI binary is the worst possible regression: app starts, every
// session crashes with "Native CLI binary not found". A glob typo in
// asarUnpack or a missing optional-dep on disk are silent failures
// otherwise; this hook turns them into a hard build failure.
//
// SDK lookup (sdk.mjs `V7`):
//   createRequire(<sdk.mjs>).resolve(
//     '@anthropic-ai/claude-agent-sdk-<platform-arch>/<binaryName>'
//   )
// resolved relative to claude-agent-sdk/sdk.mjs at runtime. sdk.mjs itself
// stays inside app.asar (it's pure JS, no need to unpack); Electron's asar
// shim transparently redirects file-system reads of unpacked-glob-matched
// paths to app.asar.unpacked. So the binary MUST exist on disk under
// app.asar.unpacked at one of the two layouts npm produces:
//   (a) <unpacked>/node_modules/@anthropic-ai/claude-agent-sdk-<platform-arch>/
//   (b) <unpacked>/node_modules/@anthropic-ai/claude-agent-sdk/
//          node_modules/@anthropic-ai/claude-agent-sdk-<platform-arch>/
// Both satisfy Node's resolution from sdk.mjs (it walks parent
// node_modules). On this codebase npm currently produces (b) — the
// platform sub-package is hoisted into the SDK's own node_modules — so we
// accept either.
//
// Scope: win32-x64, darwin-x64, darwin-arm64. Other platforms/arches are
// out of scope and the hook no-ops for them so local dev runs don't
// surprise people with red builds for an orthogonal reason.

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  // electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64
  const archName = ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' })[arch] ?? String(arch);

  const supportedPlatforms = {
    'win32-x64': 'claude.exe',
    'darwin-x64': 'claude',
    'darwin-arm64': 'claude',
  };
  const platformKey = `${electronPlatformName}-${archName}`;
  const binaryName = supportedPlatforms[platformKey];
  if (!binaryName) {
    console.log(`[after-pack] Skipping SDK binary check for ${platformKey} (not in supported scope).`);
    return;
  }

  // On macOS, appOutDir is e.g. release/mac and resources live inside
  // the .app bundle at CCSM.app/Contents/Resources/. On Windows/Linux,
  // resources are directly at appOutDir/resources/.
  let resourcesDir;
  if (electronPlatformName === 'darwin') {
    // Find the .app bundle inside appOutDir
    const appBundle = fs
      .readdirSync(appOutDir)
      .find((name) => name.endsWith('.app'));
    if (!appBundle) {
      throw new Error(
        `[after-pack] No .app bundle found in ${appOutDir}`,
      );
    }
    resourcesDir = path.join(appOutDir, appBundle, 'Contents', 'Resources');
  } else {
    resourcesDir = path.join(appOutDir, 'resources');
  }

  const unpackedRoot = path.join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
  );
  const candidates = [
    // Layout (a): top-level peer of claude-agent-sdk
    path.join(unpackedRoot, `claude-agent-sdk-${platformKey}`, binaryName),
    // Layout (b): nested under claude-agent-sdk's own node_modules
    path.join(
      unpackedRoot,
      'claude-agent-sdk',
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${platformKey}`,
      binaryName,
    ),
  ];

  const found = candidates.find((p) => fs.existsSync(p));

  if (!found) {
    let listing = '<missing>';
    try {
      listing = fs.readdirSync(unpackedRoot).join(', ') || '<empty>';
    } catch {
      // unpackedRoot may not exist at all — listing stays <missing>
    }
    throw new Error(
      `[after-pack] Expected SDK binary at one of:\n` +
        candidates.map((p) => `  - ${p}`).join('\n') +
        `\n  but none exist on disk.\n` +
        `  unpacked @anthropic-ai contents: ${listing}\n` +
        `Hint: check that build.asarUnpack covers ` +
        `**/node_modules/@anthropic-ai/claude-agent-sdk-*/** and that ` +
        `@anthropic-ai/claude-agent-sdk-${platformKey} is installed in node_modules.`,
    );
  }

  const sizeMB = (fs.statSync(found).size / 1024 / 1024).toFixed(1);
  console.log(`[after-pack] OK ${platformKey}: ${binaryName} present (${sizeMB} MB) at ${found}`);
};

