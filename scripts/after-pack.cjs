// electron-builder afterPack hook (PR-B, win-x64 only).
//
// Verify the @anthropic-ai/claude-agent-sdk-win32-x64/claude.exe binary
// actually landed inside app.asar.unpacked. Shipping an installer with no
// `claude.exe` is the worst possible regression: app starts, every session
// crashes with "Native CLI binary not found". A glob typo in asarUnpack or
// a missing optional-dep on disk are silent failures otherwise; this hook
// turns them into a hard build failure.
//
// SDK lookup (sdk.mjs `V7`):
//   createRequire(<sdk.mjs>).resolve(
//     '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
//   )
// resolved relative to claude-agent-sdk/sdk.mjs at runtime. sdk.mjs itself
// stays inside app.asar (it's pure JS, no need to unpack); Electron's asar
// shim transparently redirects file-system reads of unpacked-glob-matched
// paths to app.asar.unpacked. So the binary MUST exist on disk under
// app.asar.unpacked at one of the two layouts npm produces:
//   (a) <unpacked>/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/
//   (b) <unpacked>/node_modules/@anthropic-ai/claude-agent-sdk/
//          node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/
// Both satisfy Node's resolution from sdk.mjs (it walks parent
// node_modules). On this codebase npm currently produces (b) — the
// platform sub-package is hoisted into the SDK's own node_modules — so we
// accept either.
//
// Scope: only win32-x64. Other platforms/arches are out of scope for PR-B
// and will land in a follow-up PR; the hook no-ops for them so local dev
// runs of `make:mac` etc. don't surprise people with red builds for an
// orthogonal reason.

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  // electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64
  const archName = ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' })[arch] ?? String(arch);

  if (electronPlatformName !== 'win32' || archName !== 'x64') {
    console.log(
      `[after-pack] Skipping SDK binary check for ${electronPlatformName}/${archName} ` +
        `(PR-B scope is win32/x64 only).`,
    );
    return;
  }

  const unpackedRoot = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
  );
  const candidates = [
    // Layout (a): top-level peer of claude-agent-sdk
    path.join(unpackedRoot, 'claude-agent-sdk-win32-x64', 'claude.exe'),
    // Layout (b): nested under claude-agent-sdk's own node_modules
    path.join(
      unpackedRoot,
      'claude-agent-sdk',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-win32-x64',
      'claude.exe',
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
        `@anthropic-ai/claude-agent-sdk-win32-x64 is installed in node_modules.`,
    );
  }

  const sizeMB = (fs.statSync(found).size / 1024 / 1024).toFixed(1);
  console.log(`[after-pack] OK win32/x64: claude.exe present (${sizeMB} MB) at ${found}`);

  // Notifications native chain check (win32 only). Same failure mode as the
  // SDK binary above: a missing electron-windows-notifications .node leaves
  // the runtime wrapper permanently in fallback mode and the user gets ZERO
  // OS toasts. The native addon MUST live under app.asar.unpacked since
  // .node files cannot be loaded from inside an asar archive. We assert
  // both the top-level package and at least one @nodert-win10-au peer (the
  // package transitively requires the chain at module load time).
  const notifyNativeDir = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'electron-windows-notifications',
  );
  const notifyBuildRelease = path.join(notifyNativeDir, 'build', 'Release');
  let notifyDotNodes = [];
  try {
    notifyDotNodes = fs
      .readdirSync(notifyBuildRelease)
      .filter((n) => n.endsWith('.node'));
  } catch {
    // directory missing — caught below
  }
  if (notifyDotNodes.length === 0) {
    let nmListing = '<missing>';
    try {
      nmListing = fs
        .readdirSync(path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules'))
        .join(', ') || '<empty>';
    } catch {
      // unpacked node_modules root missing entirely — listing stays <missing>
    }
    throw new Error(
      `[after-pack] Expected at least one .node file under:\n` +
        `  ${notifyBuildRelease}\n` +
        `  but the directory is missing or empty.\n` +
        `  app.asar.unpacked/node_modules contents: ${nmListing}\n` +
        `Hint: ensure electron-windows-notifications is in dependencies (not ` +
        `optionalDependencies), check that build.asarUnpack covers ` +
        `**/node_modules/electron-windows-notifications/** and ` +
        `**/node_modules/@nodert-win10-au/**, and verify postinstall ` +
        `rebuilt the native chain successfully.`,
    );
  }

  const nodertDir = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@nodert-win10-au',
  );
  let nodertPkgs = [];
  try {
    nodertPkgs = fs.readdirSync(nodertDir);
  } catch {
    // missing — caught below
  }
  if (nodertPkgs.length === 0) {
    throw new Error(
      `[after-pack] Expected @nodert-win10-au native packages under:\n` +
        `  ${nodertDir}\n` +
        `  but the directory is missing or empty. ` +
        `electron-windows-notifications requires this chain at runtime; ` +
        `without it require('electron-windows-notifications') throws and ` +
        `no OS toast is ever emitted.\n` +
        `Hint: confirm build.asarUnpack covers ` +
        `**/node_modules/@nodert-win10-au/** and that the chain installed ` +
        `successfully (postinstall step).`,
    );
  }

  console.log(
    `[after-pack] OK win32/x64: notifications native chain present ` +
      `(${notifyDotNodes.join(', ')}; @nodert-win10-au peers: ${nodertPkgs.length}).`,
  );
};

